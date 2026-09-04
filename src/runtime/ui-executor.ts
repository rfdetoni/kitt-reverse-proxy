import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import { logger } from '../logger.js';
import type { ProviderPreset } from '../providers/catalog.js';
import { detectBrowserGate, type BrowserGate } from '../security/challenge.js';
import type {
  AppConfig,
  ChatExecutionOptions,
  ChatExecutionResult,
  ChatExecutor,
  JsonObject,
  OpenAiCompletion,
  LiveBrowserSession
} from '../types.js';
import { anyVisible, collectVisibleSnapshots, extractArtifactContents, filterNewArtifacts, firstVisibleLocator, selectChangedSnapshot, type UiTextSnapshot } from './ui-dom.js';
import { navigateSession } from './browser-session.js';
import {
  buildToolProtocolPlan,
  formatApiDirective,
  formatToolResultPrompt,
  requestMayReturnToolCalls,
  toolProtocolFingerprint,
  ToolProtocolError,
  type OpenAiToolCall
} from '../mapping/tool-calling.js';
import {
  canonicalMessages,
  computeDeltas,
  deltaFromCumulative,
  selectMinimalUiPrompts,
  historyFingerprint,
  historyIsPrefix,
  userTurnsAreCompatible,
  type CanonicalMessage
} from './ui-history.js';
import {
  parseUiToolResponse,
  buildToolRetryPrompt,
  ToolParseFailedError
} from './tool-response.js';
import {
  structuredOutputPlan,
  validateStructuredOutput,
  buildStructuredRetryPrompt
} from './structured-output.js';
import { uploadImagesFromBody } from './multimodal.js';
import { telemetry } from '../util/telemetry.js';
import {
  ToolEnforcementError,
  buildToolEnforcementDirective,
  buildToolEnforcementPlan,
  buildToolEnforcementRetryPrompt,
  enforceToolResponse,
  isExplorationToolCall,
  toolEnforcementTaskKey,
  type ToolEnforcementPlan
} from './tool-enforcement.js';

const POLL_MS = 175;
const MAX_UI_PROMPT_CHARS = 500_000;

export class ManualInterventionRequiredError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'ManualInterventionRequiredError';
  }
}

export class UiAutomationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UiAutomationError';
  }
}

export class ConversationStateConflictError extends Error {
  constructor() {
    super('O histórico recebido pertence a outra conversa. Use /v1/kitt/reset ou uma instância/porta dedicada.');
    this.name = 'ConversationStateConflictError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function completion(model: string, content: string | null, toolCalls?: OpenAiToolCall[]): OpenAiCompletion {
  return {
    id: `chatcmpl-web-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content,
        ...(toolCalls?.length ? { tool_calls: toolCalls } : {})
      },
      finish_reason: toolCalls?.length ? 'tool_calls' : 'stop'
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}

async function gateMessage(page: Page, provider: ProviderPreset): Promise<BrowserGate | null> {
  return detectBrowserGate(page, provider.ui.inputSelectors);
}

function isThinkingIndicator(text: string): boolean {
  const t = text.trim().toLowerCase();
  return (
    t === 'pensando' ||
    t === 'pensando...' ||
    t === 'thinking' ||
    t === 'thinking...' ||
    /^pensou (durante|por|há) \d+/i.test(t) ||
    /^thought for \d+/i.test(t) ||
    /^pensando (há|por) \d+/i.test(t)
  );
}

export class UiChatExecutor implements ChatExecutor {
  readonly transport = 'ui' as const;
  readonly modelId: string;
  private history: CanonicalMessage[] = [];
  private protocolFingerprint = '';
  private toolProtocolWasEnabled = false;
  private systemContextWasEnabled = false;
  private readonly toolNamesByCallId = new Map<string, string>();
  private lastRequestFingerprint = '';
  private lastResult: ChatExecutionResult | undefined;
  private enforcementTaskKey = '';
  private explorationEvidence = false;
  private toolEvidence = false;
  private readonly explorationCallIds = new Set<string>();

  constructor(
    private readonly session: LiveBrowserSession,
    private readonly provider: ProviderPreset,
    private readonly config: AppConfig
  ) {
    this.modelId = config.apiModel || provider.defaultApiModel;
  }

  async initialize(): Promise<void> {
    await this.waitForReady('inicialização');
  }

  private async waitForReady(reason: string): Promise<void> {
    const deadline = Date.now() + this.config.manualInterventionTimeoutMs;
    let lastGate = '';
    let waitingLogged = false;

    while (Date.now() < deadline) {
      const input = await firstVisibleLocator(this.session.page, this.provider.ui.inputSelectors);
      if (input) return;

      const gate = await gateMessage(this.session.page, this.provider);
      if (gate) {
        if (!this.config.headed) {
          throw new ManualInterventionRequiredError(`${gate.message} Reinicie em modo headed e resolva manualmente.`);
        }
        if (lastGate !== gate.kind) {
          logger.warn(`${gate.message} Resolva manualmente no Chromium; o proxy retomará quando o chat estiver disponível.`);
          lastGate = gate.kind;
        }
      } else if (!waitingLogged) {
        logger.info(`Aguardando campo de chat (${reason}). Se houver login ou consentimento, conclua manualmente no Chromium.`);
        waitingLogged = true;
      }
      await sleep(500);
    }

    throw new ManualInterventionRequiredError(
      `Campo de chat não ficou disponível em ${Math.round(this.config.manualInterventionTimeoutMs / 1000)}s.`
    );
  }

  private async sendPrompt(prompt: string): Promise<void> {
    if (!prompt.trim()) throw new UiAutomationError('Não há conteúdo novo para enviar ao chat web.');
    if (prompt.length > MAX_UI_PROMPT_CHARS) throw new UiAutomationError(`Prompt via UI excede ${MAX_UI_PROMPT_CHARS} caracteres.`);

    await this.waitForReady('envio');
    const input = await firstVisibleLocator(this.session.page, this.provider.ui.inputSelectors);
    if (!input) throw new UiAutomationError('Campo de entrada do chat não foi localizado.');

    await input.focus().catch(() => undefined);
    await input.click({ force: true, timeout: 2_000 }).catch(() => undefined);

    // Modern Lexical/ProseMirror editors require true input/keyboard events
    const isContentEditable = await input.getAttribute('contenteditable').catch(() => null);
    if (isContentEditable === 'true' || isContentEditable === '') {
      await input.press('ControlOrMeta+A').catch(() => undefined);
      await input.press('Backspace').catch(() => undefined);
      await this.session.page.keyboard.insertText(prompt);
    } else {
      try {
        await input.fill(prompt, { timeout: 2_000 });
      } catch {
        await input.press('ControlOrMeta+A').catch(() => undefined);
        await input.press('Backspace').catch(() => undefined);
        await this.session.page.keyboard.insertText(prompt);
      }
    }

    // Give the frontend 150ms to register the state update
    await sleep(150);

    const send = await firstVisibleLocator(this.session.page, this.provider.ui.sendSelectors);
    if (send && await send.isEnabled().catch(() => false)) {
      await send.click({ force: true, timeout: 3_000 }).catch(() => undefined);
      return;
    }
    await input.press('Enter', { timeout: 3_000 }).catch(() => undefined);
  }

  private async awaitResponse(
    baseline: readonly UiTextSnapshot[],
    sentPrompt: string,
    onDelta?: ChatExecutionOptions['onDelta']
  ): Promise<{ text: string; snapshots: string[] }> {
    const deadline = Date.now() + this.config.uiResponseTimeoutMs;
    let lastText = '';
    let streamedText = '';
    let stableSince = 0;
    const snapshots: string[] = [];

    // Give web chat a moment to transition to thinking/generating state
    await sleep(350);

    while (Date.now() < deadline) {
      const gate = await gateMessage(this.session.page, this.provider);
      if (gate) {
        if (!this.config.headed) throw new ManualInterventionRequiredError(`${gate.message} Requer intervenção manual.`);
        await this.waitForReady('desafio de segurança');
      }

      const streaming = await anyVisible(this.session.page, this.provider.ui.streamingSelectors);
      const current = await collectVisibleSnapshots(this.session.page, this.provider.ui.responseSelectors);
      const activeSnapshot = selectChangedSnapshot(baseline, current, sentPrompt);

      if (activeSnapshot?.text) {
        if (activeSnapshot.text !== lastText) {
          lastText = activeSnapshot.text;
          snapshots.push(activeSnapshot.text);
          stableSince = Date.now();
          if (!isThinkingIndicator(activeSnapshot.text)) {
            const delta = deltaFromCumulative(streamedText, activeSnapshot.text);
            if (delta) {
              streamedText = activeSnapshot.text.trim();
              await onDelta?.(delta);
            }
          }
        }
      }

      // Finish when the model has completed thinking/generating (stop button gone), is not thinking indicator, and text settled
      if (!streaming && lastText && !isThinkingIndicator(lastText)) {
        if (stableSince === 0) stableSince = Date.now();
        if (Date.now() - stableSince >= Math.max(1500, this.config.uiSettleMs)) {
          return { text: lastText, snapshots };
        }
      }

      // Safety completion ONLY when not streaming and text is a real answer
      if (!streaming && lastText && !isThinkingIndicator(lastText) && stableSince > 0 && Date.now() - stableSince >= Math.max(3000, this.config.uiSettleMs * 2)) {
        return { text: lastText, snapshots };
      }

      await sleep(POLL_MS);
    }

    if (lastText && !isThinkingIndicator(lastText)) return { text: lastText, snapshots };
    throw new UiAutomationError(`Nenhuma resposta do chat foi detectada em ${Math.round(this.config.uiResponseTimeoutMs / 1000)}s.`);
  }

  async reset(): Promise<void> {
    this.history = [];
    this.lastRequestFingerprint = '';
    this.lastResult = undefined;
    this.protocolFingerprint = '';
    this.toolProtocolWasEnabled = false;
    this.systemContextWasEnabled = false;
    this.toolNamesByCallId.clear();
    this.enforcementTaskKey = '';
    this.explorationEvidence = false;
    this.toolEvidence = false;
    this.explorationCallIds.clear();
    const destination = this.provider.ui.newChatUrl || this.config.targetUrl;
    await navigateSession(this.session, destination, this.config.manualInterventionTimeoutMs)
      .catch((error: unknown) => {
        throw new UiAutomationError(`Falha ao iniciar nova conversa: ${error instanceof Error ? error.message : String(error)}`);
      });
    await this.waitForReady('nova conversa');
  }

  private pendingMessages(incoming: CanonicalMessage[]): CanonicalMessage[] {
    if (!this.history.length) return incoming;
    if (historyIsPrefix(this.history, incoming)) return incoming.slice(this.history.length);

    // If incoming contains a multi-turn array, extract only the new messages following the last assistant turn
    const lastAsstIdx = incoming.map((m) => m.role).lastIndexOf('assistant');
    if (lastAsstIdx >= 0 && lastAsstIdx < incoming.length - 1) {
      return incoming.slice(lastAsstIdx + 1);
    }

    // If only user/tool turns without assistant, send the last turn or all incoming
    if (incoming.length === 1 && ['user', 'tool'].includes(incoming[0]!.role)) return incoming;
    return [incoming[incoming.length - 1]!];
  }

  async execute(body: JsonObject, options?: ChatExecutionOptions): Promise<ChatExecutionResult> {
    const incoming = canonicalMessages(body);
    if (!incoming.length) throw new UiAutomationError('Nenhuma mensagem textual utilizável foi recebida.');

    const fingerprint = historyFingerprint(incoming);
    if (incoming.length > 1 && fingerprint === this.lastRequestFingerprint && this.lastResult) {
      return this.lastResult;
    }

    const previousUserTurns = this.history.filter((message) => message.role === 'user').length;
    const incomingUserTurns = incoming.filter((message) => message.role === 'user').length;
    if (
      incoming.length > 1
      && this.history.length
      && (
        !userTurnsAreCompatible(this.history, incoming)
        || incomingUserTurns < previousUserTurns
      )
    ) {
      logger.info('Novo histórico de conversa detectado pelo cliente API. Executando reset automático da sessão browser...');
      await this.reset();
    }

    const pending = this.pendingMessages(incoming);
    if (!pending.length) throw new UiAutomationError('A requisição não contém um novo turno para enviar ao chat web.');

    const selectedPrompts = selectMinimalUiPrompts(pending);
    const selectedPrompt = selectedPrompts.at(-1);
    if (!selectedPrompt) {
      throw new UiAutomationError(
        'O transporte UI não injeta mensagens system/developer/assistant no chat web. Envie um novo turno user (ou tool quando indispensável).'
      );
    }
    const systemMessages = incoming.filter((m) => ['system', 'developer'].includes(m.role));
    const systemPrompt = systemMessages.map((m) => m.text).filter(Boolean).join('\n\n');
    const plan = buildToolProtocolPlan(body, systemPrompt || undefined);
    const protocolFingerprint = toolProtocolFingerprint(plan);
    const protocolEnabled = plan.tools.length > 0 && plan.choice.mode !== 'none';
    const currentTaskKey = toolEnforcementTaskKey(incoming);
    if (currentTaskKey !== this.enforcementTaskKey) {
      this.enforcementTaskKey = currentTaskKey;
      this.explorationEvidence = false;
      this.toolEvidence = false;
      this.explorationCallIds.clear();
    }
    const latestUserText = [...incoming].reverse().find((message) => message.role === 'user')?.text ?? '';
    const enforcement: ToolEnforcementPlan = buildToolEnforcementPlan(
      plan,
      latestUserText,
      this.config.toolEnforcement ?? 'explore-first'
    );

    let actionablePrompt = selectedPrompt.text;
    if (selectedPrompt.role === 'tool') {
      const toolResults = selectedPrompts.map((toolPrompt) => {
        const rememberedName = toolPrompt.toolCallId
          ? this.toolNamesByCallId.get(toolPrompt.toolCallId)
          : undefined;
        if (toolPrompt.toolCallId && !rememberedName && !toolPrompt.toolName) {
          throw new ToolProtocolError(
            `tool_call_id desconhecido para esta conversa: ${toolPrompt.toolCallId}`
          );
        }
        const toolName = toolPrompt.toolName || rememberedName;
        if (toolName && plan.tools.length && !plan.tools.some((tool) => tool.name === toolName)) {
          throw new ToolProtocolError(`Resultado recebido para function não disponível: ${toolName}`);
        }
        this.toolEvidence = true;
        if (toolPrompt.toolCallId && this.explorationCallIds.has(toolPrompt.toolCallId)) {
          this.explorationEvidence = true;
        }
        return formatToolResultPrompt(
          toolPrompt.text,
          toolPrompt.toolCallId,
          toolName
        );
      });
      actionablePrompt = toolResults.join('\n');
    }

    const structured = structuredOutputPlan(body);
    let prefix = protocolFingerprint !== this.protocolFingerprint
      ? formatApiDirective(plan)
      : '';
    if (!protocolEnabled && this.toolProtocolWasEnabled) {
      prefix = `[API TOOL PROTOCOL UPDATE]\nTools are disabled for this turn. Do not emit tool calls.\n[END API TOOL PROTOCOL UPDATE]\n\n${prefix}`;
    }
    if (!plan.systemPrompt && this.systemContextWasEnabled) {
      prefix = `[API SYSTEM CONTEXT UPDATE]\nThe previous API system context is no longer active for this turn. Follow the current user request without that prior API system context.\n[END API SYSTEM CONTEXT UPDATE]\n\n${prefix}`;
    }
    if (structured) {
      prefix = `${prefix}[RESPONSE FORMAT INSTRUCTION]\n${structured.instruction}\n[END RESPONSE FORMAT INSTRUCTION]\n\n`;
    }
    prefix = `${prefix}${buildToolEnforcementDirective(enforcement, this.explorationEvidence, this.toolEvidence)}`;

    const fallbackPublicImageUrls = await uploadImagesFromBody(this.session.page, this.provider, body);
    if (fallbackPublicImageUrls.length > 0) {
      actionablePrompt = `${actionablePrompt}\n\n${fallbackPublicImageUrls.map((url) => `Image: ${url}`).join('\n')}`;
    }

    const prompt = `${prefix}${actionablePrompt}`;

    const artifactBaseline = await extractArtifactContents(this.session.page).catch(() => []);
    const baseline = await collectVisibleSnapshots(this.session.page, this.provider.ui.responseSelectors);
    await this.sendPrompt(prompt);

    // Internal tool protocol text or structured validation buffer must never leak to an API stream prematurely.
    const bufferResponse = requestMayReturnToolCalls(body) || Boolean(structured);
    const result = await this.awaitResponse(
      baseline,
      prompt,
      bufferResponse ? undefined : options?.onDelta
    );
    const model = typeof body.model === 'string' && body.model.trim() ? body.model : this.modelId;
    let textToParse = result.text;

    // Check if the chat generated artifacts/files (e.g. Canvas or download buttons) that were not inlined
    const artifactsAfter = await extractArtifactContents(this.session.page).catch(() => []);
    const artifacts = filterNewArtifacts(artifactBaseline, artifactsAfter);
    if (artifacts.length > 0) {
      const artifactBlocks = artifacts
        .filter((art) => !textToParse.includes(art.code))
        .map((art) => {
          const lang = art.language || (art.filename?.split('.').pop()) || '';
          const header = art.filename ? `File: ${art.filename}\n` : '';
          return `${header}\`\`\`${lang}\n${art.code}\n\`\`\``;
        });
      if (artifactBlocks.length > 0) {
        textToParse = `${textToParse}\n\n${artifactBlocks.join('\n\n')}`;
      }
    }

    let parsed;
    for (let attempt = 0; ; attempt += 1) {
      try {
        parsed = parseUiToolResponse(textToParse, plan, artifacts, this.provider.id);
        enforceToolResponse({
          enforcement,
          protocol: plan,
          calls: parsed.tool_calls,
          explorationEvidence: this.explorationEvidence,
          toolEvidence: this.toolEvidence
        });
        break;
      } catch (error) {
        const retryable = error instanceof ToolProtocolError && error.source === 'model';
        if (!protocolEnabled || !retryable || attempt >= 2) {
          if (error instanceof ToolEnforcementError || error instanceof ToolParseFailedError) throw error;
          throw retryable
            ? new ToolParseFailedError(error instanceof Error ? error.message : String(error))
            : error;
        }
        telemetry.recordToolCall(this.provider.id, 'unknown', 'retry');
        const retryPrompt = error instanceof ToolEnforcementError
          ? buildToolEnforcementRetryPrompt(enforcement, error)
          : buildToolRetryPrompt(plan, error instanceof Error ? error.message : String(error));
        const retryBaseline = await collectVisibleSnapshots(this.session.page, this.provider.ui.responseSelectors);
        await this.sendPrompt(retryPrompt);
        const retryResult = await this.awaitResponse(retryBaseline, retryPrompt);
        textToParse = retryResult.text;
      }
    }

    let structuredOutputFailed = false;
    if (!parsed.tool_calls?.length && structured) {
      let checked = validateStructuredOutput(textToParse, structured);
      if (!checked.ok) {
        const retryPrompt = buildStructuredRetryPrompt(structured, checked.error);
        const retryBaseline = await collectVisibleSnapshots(this.session.page, this.provider.ui.responseSelectors);
        await this.sendPrompt(retryPrompt);
        const retryResult = await this.awaitResponse(retryBaseline, retryPrompt);
        checked = validateStructuredOutput(retryResult.text, structured);
      }
      if (checked.ok) {
        textToParse = checked.text;
      } else {
        structuredOutputFailed = true;
      }
    }

    for (const call of parsed.tool_calls || []) {
      this.toolNamesByCallId.set(call.id, call.function.name);
      if (isExplorationToolCall(call, plan)) this.explorationCallIds.add(call.id);
    }

    const responseContent = parsed.tool_calls?.length ? parsed.content : textToParse;
    const output = completion(model, responseContent, parsed.tool_calls);
    this.protocolFingerprint = protocolFingerprint;
    this.toolProtocolWasEnabled = protocolEnabled;
    this.systemContextWasEnabled = Boolean(plan.systemPrompt);

    if (historyIsPrefix(this.history, incoming)) this.history = [...incoming, { role: 'assistant', text: textToParse }];
    else if (incoming.length === 1 && this.history.length) this.history = [...this.history, ...incoming, { role: 'assistant', text: textToParse }];
    else this.history = [...incoming, { role: 'assistant', text: textToParse }];

    const execution: ChatExecutionResult = {
      completion: output,
      deltas: parsed.tool_calls?.length
        ? []
        : computeDeltas(result.snapshots, responseContent || ''),
      ...(structuredOutputFailed ? { metadata: { structured_output: 'failed' } } : {})
    };
    if (incoming.length > 1) {
      this.lastRequestFingerprint = fingerprint;
      this.lastResult = execution;
    } else {
      this.lastRequestFingerprint = '';
      this.lastResult = undefined;
    }
    return execution;
  }

  describe(): JsonObject {
    return {
      provider: this.provider.id,
      providerName: this.provider.name,
      transport: 'ui',
      targetOrigin: new URL(this.config.targetUrl).origin,
      persistentSession: this.session.persistent,
      manualChallengeHandling: true,
      progressiveUiStreaming: true,
      toolCalling: 'protocol-emulated',
      toolExecution: 'client-side',
      toolEnforcement: this.config.toolEnforcement ?? 'explore-first'
    };
  }
}

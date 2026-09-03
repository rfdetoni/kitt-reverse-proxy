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
  assertToolChoiceSatisfied,
  buildToolProtocolPlan,
  extractToolCalls,
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

function completion(model: string, content: string | null, toolCalls?: any[]): OpenAiCompletion {
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
        return formatToolResultPrompt(
          toolPrompt.text,
          toolPrompt.toolCallId,
          toolName
        );
      });
      actionablePrompt = toolResults.join('\n');
    }

    let prefix = protocolFingerprint !== this.protocolFingerprint
      ? formatApiDirective(plan)
      : '';
    if (!protocolEnabled && this.toolProtocolWasEnabled) {
      prefix = `[API TOOL PROTOCOL UPDATE]\nTools are disabled for this turn. Do not emit tool calls.\n[END API TOOL PROTOCOL UPDATE]\n\n${prefix}`;
    }
    if (!plan.systemPrompt && this.systemContextWasEnabled) {
      prefix = `[API SYSTEM CONTEXT UPDATE]\nThe previous API system context is no longer active for this turn. Follow the current user request without that prior API system context.\n[END API SYSTEM CONTEXT UPDATE]\n\n${prefix}`;
    }
    const prompt = `${prefix}${actionablePrompt}`;

    const artifactBaseline = await extractArtifactContents(this.session.page).catch(() => []);
    const baseline = await collectVisibleSnapshots(this.session.page, this.provider.ui.responseSelectors);
    await this.sendPrompt(prompt);

    // Internal tool protocol text must never leak to an API stream. For a turn
    // that can return tools we buffer the web response, parse/validate it, then
    // emit the proper API-native tool-call representation.
    const bufferToolProtocol = requestMayReturnToolCalls(body);
    const result = await this.awaitResponse(
      baseline,
      prompt,
      bufferToolProtocol ? undefined : options?.onDelta
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

    const parsed = extractToolCalls(textToParse, plan);

    // If the agent expected a file-writing tool (e.g. write_file, write_to_file, create_file)
    // but the chat model only returned the file content as an artifact or markdown code block,
    // synthesize the tool call automatically so the IDE executes the file creation locally.
    if ((!parsed.tool_calls || parsed.tool_calls.length === 0) && artifacts.length > 0) {
      const writeFileTool = plan.tools.find((tool) =>
        ['write_file', 'write_to_file', 'create_file', 'apply_diff', 'edit_file'].includes(tool.name)
      );
      if (writeFileTool) {
        const synthesizedCalls: OpenAiToolCall[] = [];
        for (const art of artifacts) {
          const filename = art.filename || 'index.html';
          const rawParams = writeFileTool.parameters as Record<string, any> | undefined;
          const paramProps = rawParams?.properties as Record<string, any> | undefined;
          const pathKey = paramProps && ('path' in paramProps)
            ? 'path'
            : paramProps && ('TargetFile' in paramProps)
              ? 'TargetFile'
              : paramProps && ('target_file' in paramProps)
                ? 'target_file'
                : 'path';
          const contentKey = paramProps && ('content' in paramProps)
            ? 'content'
            : paramProps && ('CodeContent' in paramProps)
              ? 'CodeContent'
              : paramProps && ('code' in paramProps)
                ? 'code'
                : 'content';

          synthesizedCalls.push({
            id: `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
            type: 'function',
            function: {
              name: writeFileTool.name,
              arguments: JSON.stringify({
                [pathKey]: filename,
                [contentKey]: art.code,
                ...(paramProps && 'Overwrite' in paramProps ? { Overwrite: true } : {}),
                ...(paramProps && 'Description' in paramProps ? { Description: `Create ${filename}` } : {})
              })
            }
          });
        }
        if (synthesizedCalls.length > 0) {
          parsed.tool_calls = synthesizedCalls;
          parsed.content = textToParse.replace(/Baixar\/abrir[^\n]*/gi, '').trim();
        }
      }
    }

    assertToolChoiceSatisfied(plan, parsed.tool_calls);

    for (const call of parsed.tool_calls || []) {
      this.toolNamesByCallId.set(call.id, call.function.name);
    }

    const responseContent = parsed.tool_calls?.length ? parsed.content : textToParse;
    const output = completion(model, responseContent, parsed.tool_calls);
    this.protocolFingerprint = protocolFingerprint;
    this.toolProtocolWasEnabled = protocolEnabled;
    this.systemContextWasEnabled = Boolean(plan.systemPrompt);

    if (historyIsPrefix(this.history, incoming)) this.history = [...incoming, { role: 'assistant', text: textToParse }];
    else if (incoming.length === 1 && this.history.length) this.history = [...this.history, ...incoming, { role: 'assistant', text: textToParse }];
    else this.history = [...incoming, { role: 'assistant', text: textToParse }];

    const execution = {
      completion: output,
      deltas: parsed.tool_calls?.length
        ? []
        : computeDeltas(result.snapshots, responseContent || '')
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
      toolExecution: 'client-side'
    };
  }
}

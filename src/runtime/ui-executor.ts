import { createHash, randomUUID } from 'node:crypto';
import { RESOURCE_LIMITS } from '../core/resource-limits.js';
import { logger } from '../logger.js';
import type { ProviderPreset } from '../providers/catalog.js';
import type {
  AppConfig,
  ChatExecutionOptions,
  ChatExecutionResult,
  ChatExecutor,
  JsonObject,
  OpenAiCompletion,
  LiveBrowserSession
} from '../types.js';
import {
  collectVisibleSnapshots,
  extractArtifactContents,
  filterNewArtifacts,
  type UiTextSnapshot
} from './ui-dom.js';
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
  selectMinimalUiPrompts,
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
  applyReasoningEffort,
  ReasoningLevelUnavailableError,
  ReasoningNotSupportedError
} from './reasoning.js';
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
import { throwIfAborted } from './cancellation.js';
import { sendUiPrompt, waitForUiReady } from './ui-interaction.js';
import { awaitUiResponse } from './ui-response-monitor.js';
import {
  ConversationStateConflictError,
  ManualInterventionRequiredError,
  UiAutomationError,
  UiTimeoutError
} from './ui-errors.js';

export {
  ConversationStateConflictError,
  ManualInterventionRequiredError,
  UiAutomationError,
  UiTimeoutError
} from './ui-errors.js';

const MAX_TRACKED_TOOL_CALLS = 256;

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

function requestFingerprint(body: JsonObject, reasoningEffort?: number): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(body));
  hash.update('\u0000');
  hash.update(reasoningEffort === undefined ? '-' : String(reasoningEffort));
  return hash.digest('hex');
}

function historyChars(messages: readonly CanonicalMessage[]): number {
  let total = 0;
  for (const message of messages) total += message.role.length + message.text.length + (message.toolCallId?.length ?? 0) + (message.toolName?.length ?? 0);
  return total;
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

  private async waitForReady(reason: string, signal?: AbortSignal): Promise<void> {
    await waitForUiReady(this.session, this.provider, this.config, reason, signal);
  }

  private async sendPrompt(prompt: string, signal?: AbortSignal): Promise<void> {
    await sendUiPrompt(this.session, this.provider, this.config, prompt, signal);
  }

  private async awaitResponse(
    baseline: readonly UiTextSnapshot[],
    sentPrompt: string,
    onDelta?: ChatExecutionOptions['onDelta'],
    signal?: AbortSignal
  ): Promise<{ text: string; deltas?: string[]; snapshots?: string[]; firstDeltaMs: number | undefined; durationMs: number }> {
    return await awaitUiResponse(this.session, this.provider, this.config, baseline, sentPrompt, onDelta, signal);
  }

  async reset(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
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
    await this.waitForReady('nova conversa', signal);
  }

  private pendingMessages(incoming: CanonicalMessage[]): CanonicalMessage[] {
    if (!this.history.length) return incoming;
    if (historyIsPrefix(this.history, incoming)) return incoming.slice(this.history.length);

    const lastAssistant = incoming.map((message) => message.role).lastIndexOf('assistant');
    if (lastAssistant >= 0 && lastAssistant < incoming.length - 1) return incoming.slice(lastAssistant + 1);
    if (incoming.length === 1 && ['user', 'tool'].includes(incoming[0]!.role)) return incoming;
    return [incoming[incoming.length - 1]!];
  }

  private rememberToolCall(call: OpenAiToolCall, exploration: boolean): void {
    if (!this.toolNamesByCallId.has(call.id) && this.toolNamesByCallId.size >= MAX_TRACKED_TOOL_CALLS) {
      const oldest = this.toolNamesByCallId.keys().next().value as string | undefined;
      if (oldest) {
        this.toolNamesByCallId.delete(oldest);
        this.explorationCallIds.delete(oldest);
      }
    }
    this.toolNamesByCallId.set(call.id, call.function.name);
    if (exploration) this.explorationCallIds.add(call.id);
  }

  private storeHistory(incoming: CanonicalMessage[], assistantText: string): void {
    let next: CanonicalMessage[];
    if (historyIsPrefix(this.history, incoming)) next = [...incoming, { role: 'assistant', text: assistantText }];
    else if (incoming.length === 1 && this.history.length) next = [...this.history, ...incoming, { role: 'assistant', text: assistantText }];
    else next = [...incoming, { role: 'assistant', text: assistantText }];

    // Keep the client-provided prefix if caching the assistant answer would cross the memory budget.
    this.history = historyChars(next) <= RESOURCE_LIMITS.uiHistoryChars ? next : [...incoming];
  }

  async execute(body: JsonObject, options?: ChatExecutionOptions): Promise<ChatExecutionResult> {
    const executionStartedAt = Date.now();
    throwIfAborted(options?.signal);
    const incoming = canonicalMessages(body);
    if (!incoming.length) throw new UiAutomationError('Nenhuma mensagem textual utilizável foi recebida.');
    if (historyChars(incoming) > RESOURCE_LIMITS.uiHistoryChars) {
      throw new UiAutomationError(`Histórico UI excede ${RESOURCE_LIMITS.uiHistoryChars} caracteres.`);
    }

    const fingerprint = requestFingerprint(body, options?.reasoningEffort);
    if (incoming.length > 1 && fingerprint === this.lastRequestFingerprint && this.lastResult) return this.lastResult;

    const previousUserTurns = this.history.filter((message) => message.role === 'user').length;
    const incomingUserTurns = incoming.filter((message) => message.role === 'user').length;
    if (
      incoming.length > 1
      && incomingUserTurns > 0
      && this.history.length
      && (!userTurnsAreCompatible(this.history, incoming) || incomingUserTurns < previousUserTurns)
    ) {
      logger.info('Novo histórico de conversa detectado pelo cliente API. Executando reset automático da sessão browser...');
      await this.reset(options?.signal);
    }

    throwIfAborted(options?.signal);
    if (options?.reasoningEffort !== undefined) {
      try {
        await applyReasoningEffort(this.session.page, this.provider, options.reasoningEffort);
      } catch (error) {
        if (error instanceof ReasoningLevelUnavailableError || error instanceof ReasoningNotSupportedError) {
          logger.warn(`Reasoning effort ${options.reasoningEffort} não pôde ser aplicado (${error.message}). Prosseguindo com o nível ativo.`);
        } else {
          throw error;
        }
      }
    }

    throwIfAborted(options?.signal);
    const pending = this.pendingMessages(incoming);
    if (!pending.length) throw new UiAutomationError('A requisição não contém um novo turno para enviar ao chat web.');

    const selectedPrompts = selectMinimalUiPrompts(pending);
    const selectedPrompt = selectedPrompts.at(-1);
    if (!selectedPrompt) {
      throw new UiAutomationError('O transporte UI exige um novo turno user ou tool para avançar a conversa.');
    }

    const systemPrompt = incoming
      .filter((message) => ['system', 'developer'].includes(message.role))
      .map((message) => message.text)
      .filter(Boolean)
      .join('\n\n');
    const plan = buildToolProtocolPlan(body, systemPrompt || undefined);
    const protocolFingerprint = toolProtocolFingerprint(plan);
    const protocolEnabled = plan.tools.length > 0 && plan.choice.mode !== 'none';
    const currentTaskKey = selectedPrompt.role === 'tool' ? this.enforcementTaskKey : toolEnforcementTaskKey(incoming);
    if (currentTaskKey !== this.enforcementTaskKey) {
      this.enforcementTaskKey = currentTaskKey;
      this.explorationEvidence = false;
      this.toolEvidence = false;
      this.explorationCallIds.clear();
    }

    const latestUserText = [...incoming].reverse().find((message) => message.role === 'user')?.text
      ?? [...this.history].reverse().find((message) => message.role === 'user')?.text
      ?? '';
    const enforcement: ToolEnforcementPlan = buildToolEnforcementPlan(
      plan,
      latestUserText,
      this.config.toolEnforcement ?? 'explore-first'
    );

    let actionablePrompt = selectedPrompt.text;
    if (selectedPrompt.role === 'tool') {
      const toolResults = selectedPrompts.map((toolPrompt) => {
        const callId = toolPrompt.toolCallId;
        const rememberedName = callId ? this.toolNamesByCallId.get(callId) : undefined;
        if (callId && !rememberedName) throw new ToolProtocolError(`tool_call_id desconhecido para esta conversa: ${callId}`);
        if (rememberedName && toolPrompt.toolName && rememberedName !== toolPrompt.toolName) {
          throw new ToolProtocolError('tool_call_id não corresponde ao nome da function.');
        }
        const toolName = toolPrompt.toolName || rememberedName;
        if (toolName && plan.tools.length && !plan.tools.some((tool) => tool.name === toolName)) {
          throw new ToolProtocolError(`Resultado recebido para function não disponível: ${toolName}`);
        }
        if (rememberedName) this.toolEvidence = true;
        if (callId && this.explorationCallIds.has(callId)) this.explorationEvidence = true;
        const result = formatToolResultPrompt(toolPrompt.text, callId, toolName);
        if (callId) {
          this.toolNamesByCallId.delete(callId);
          this.explorationCallIds.delete(callId);
        }
        return result;
      });
      actionablePrompt = toolResults.join('\n');
    }

    const structured = structuredOutputPlan(body);
    let prefix = protocolFingerprint !== this.protocolFingerprint ? formatApiDirective(plan) : '';
    if (!protocolEnabled && this.toolProtocolWasEnabled) {
      prefix = `[API TOOL PROTOCOL UPDATE]\nTools are disabled for this turn. Do not emit tool calls.\n[END API TOOL PROTOCOL UPDATE]\n\n${prefix}`;
    }
    if (!plan.systemPrompt && this.systemContextWasEnabled) {
      prefix = `[API SYSTEM CONTEXT UPDATE]\nThe previous API system context is no longer active for this turn. Follow the current user request without that prior API system context.\n[END API SYSTEM CONTEXT UPDATE]\n\n${prefix}`;
    }
    if (protocolEnabled && protocolFingerprint === this.protocolFingerprint) {
      prefix += 'Print any requested tool calls as visible <tool_call>{"name":"allowed_name","arguments":{}}</tool_call> blocks. The external agent executes them; stop and wait for its tool_result.\n\n';
    }
    if (structured) prefix = `${prefix}[RESPONSE FORMAT INSTRUCTION]\n${structured.instruction}\n[END RESPONSE FORMAT INSTRUCTION]\n\n`;
    prefix = `${prefix}${buildToolEnforcementDirective(enforcement, this.explorationEvidence, this.toolEvidence)}`;

    throwIfAborted(options?.signal);
    const fallbackPublicImageUrls = await uploadImagesFromBody(this.session.page, this.provider, body);
    throwIfAborted(options?.signal);
    if (fallbackPublicImageUrls.length > 0) {
      actionablePrompt = `${actionablePrompt}\n\n${fallbackPublicImageUrls.map((url) => `Image: ${url}`).join('\n')}`;
    }

    const prompt = `${prefix}${actionablePrompt}`;
    if (prompt.length > RESOURCE_LIMITS.uiPromptChars) {
      throw new UiAutomationError(`Prompt via UI excede ${RESOURCE_LIMITS.uiPromptChars} caracteres.`);
    }

    const artifactBaseline = await extractArtifactContents(this.session.page).catch(() => []);
    const baseline = await collectVisibleSnapshots(this.session.page, this.provider.ui.responseSelectors);
    const promptSendStartedAt = Date.now();
    await this.sendPrompt(prompt, options?.signal);
    const promptSentAt = Date.now();

    const bufferResponse = requestMayReturnToolCalls(body) || Boolean(structured);
    const result = await this.awaitResponse(
      baseline,
      prompt,
      bufferResponse ? undefined : options?.onDelta,
      options?.signal
    );
    throwIfAborted(options?.signal);

    const model = typeof body.model === 'string' && body.model.trim() ? body.model : this.modelId;
    let textToParse = result.text;
    const artifactsAfter = await extractArtifactContents(this.session.page).catch(() => []);
    const artifacts = filterNewArtifacts(artifactBaseline, artifactsAfter);
    if (!protocolEnabled && artifacts.length > 0) {
      const artifactBlocks = artifacts
        .filter((artifact) => !textToParse.includes(artifact.code))
        .map((artifact) => {
          const language = artifact.language || artifact.filename?.split('.').pop() || '';
          const header = artifact.filename ? `File: ${artifact.filename}\n` : '';
          return `${header}\`\`\`${language}\n${artifact.code}\n\`\`\``;
        });
      if (artifactBlocks.length > 0) textToParse = `${textToParse}\n\n${artifactBlocks.join('\n\n')}`;
    }
    if (textToParse.length > RESOURCE_LIMITS.uiDeltaChars) {
      throw new UiAutomationError(`Resposta UI excede ${RESOURCE_LIMITS.uiDeltaChars} caracteres.`);
    }

    let parsed;
    for (let attempt = 0; ; attempt += 1) {
      throwIfAborted(options?.signal);
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
        await this.sendPrompt(retryPrompt, options?.signal);
        textToParse = (await this.awaitResponse(retryBaseline, retryPrompt, undefined, options?.signal)).text;
      }
    }

    let structuredOutputFailed = false;
    if (!parsed.tool_calls?.length && structured) {
      let checked = validateStructuredOutput(textToParse, structured);
      if (!checked.ok) {
        const retryPrompt = buildStructuredRetryPrompt(structured, checked.error);
        const retryBaseline = await collectVisibleSnapshots(this.session.page, this.provider.ui.responseSelectors);
        await this.sendPrompt(retryPrompt, options?.signal);
        const retryResult = await this.awaitResponse(retryBaseline, retryPrompt, undefined, options?.signal);
        checked = validateStructuredOutput(retryResult.text, structured);
      }
      if (checked.ok) textToParse = checked.text;
      else structuredOutputFailed = true;
    }

    for (const call of parsed.tool_calls || []) {
      this.rememberToolCall(call, isExplorationToolCall(call, plan));
    }

    const responseContent = parsed.tool_calls?.length ? parsed.content : textToParse;
    const output = completion(model, responseContent, parsed.tool_calls);
    this.protocolFingerprint = protocolFingerprint;
    this.toolProtocolWasEnabled = protocolEnabled;
    this.systemContextWasEnabled = Boolean(plan.systemPrompt);
    this.storeHistory(incoming, textToParse);

    const deltas = parsed.tool_calls?.length
      ? []
      : result.deltas
        ?? (result.snapshots ? computeDeltas(result.snapshots, responseContent || '') : (responseContent ? [responseContent] : []));
    const timing: JsonObject = {
      transport: 'ui',
      ui_prepare_ms: Math.max(0, promptSendStartedAt - executionStartedAt),
      ui_prompt_send_ms: Math.max(0, promptSentAt - promptSendStartedAt),
      ui_response_ttft_ms: result.firstDeltaMs ?? result.durationMs,
      ui_response_wait_ms: result.durationMs,
      ui_executor_total_ms: Math.max(0, Date.now() - executionStartedAt)
    };
    const execution: ChatExecutionResult = {
      completion: output,
      deltas,
      metadata: {
        ...(structuredOutputFailed ? { structured_output: 'failed' } : {}),
        timing
      }
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
      boundedHistoryChars: RESOURCE_LIMITS.uiHistoryChars,
      cancellation: 'cooperative',
      reasoning: this.provider.id === 'chatgpt'
        ? {
            supported: true,
            dynamic: true,
            header: 'X-Kitt-Reasoning-Effort',
            range: [0, 100],
            levels: ['instant', 'medium', 'high', 'extra_high']
          }
        : { supported: false },
      toolCalling: 'protocol-emulated',
      toolExecution: 'client-side',
      toolEnforcement: this.config.toolEnforcement ?? 'explore-first'
    };
  }
}

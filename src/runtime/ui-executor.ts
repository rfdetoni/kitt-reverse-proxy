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
import { anyVisible, collectVisibleSnapshots, firstVisibleLocator, selectChangedSnapshot, type UiTextSnapshot } from './ui-dom.js';
import { navigateSession } from './browser-session.js';
import {
  canonicalMessages,
  computeDeltas,
  deltaFromCumulative,
  selectMinimalUiPrompt,
  historyFingerprint,
  historyIsPrefix,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function completion(model: string, content: string): OpenAiCompletion {
  return {
    id: `chatcmpl-web-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
  };
}

async function gateMessage(page: Page, provider: ProviderPreset): Promise<BrowserGate | null> {
  return detectBrowserGate(page, provider.ui.inputSelectors);
}

export class UiChatExecutor implements ChatExecutor {
  readonly transport = 'ui' as const;
  readonly modelId: string;
  private history: CanonicalMessage[] = [];
  private warnedTools = false;
  private warnedContextPolicy = false;
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
          const delta = deltaFromCumulative(streamedText, activeSnapshot.text);
          if (delta) {
            streamedText = activeSnapshot.text.trim();
            await onDelta?.(delta);
          }
        }
      }

      // Finish when the model has completed thinking/generating (stop button gone) and text settled
      if (!streaming && lastText) {
        if (stableSince === 0) stableSince = Date.now();
        if (Date.now() - stableSince >= this.config.uiSettleMs) {
          return { text: lastText, snapshots };
        }
      }

      // Safety completion: if text has been completely stable for 3.5 seconds
      if (lastText && stableSince > 0 && Date.now() - stableSince >= Math.max(3500, this.config.uiSettleMs * 2)) {
        return { text: lastText, snapshots };
      }

      await sleep(POLL_MS);
    }

    if (lastText) return { text: lastText, snapshots };
    throw new UiAutomationError(`Nenhuma resposta do chat foi detectada em ${Math.round(this.config.uiResponseTimeoutMs / 1000)}s.`);
  }

  async reset(): Promise<void> {
    this.history = [];
    this.lastRequestFingerprint = '';
    this.lastResult = undefined;
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

    if (body.tools !== undefined && !this.warnedTools) {
      this.warnedTools = true;
      logger.warn('Transporte UI não oferece function calling nativo; tools/tool_choice não são enviados ao site como APIs de ferramenta.');
    }

    const pending = this.pendingMessages(incoming);
    if (!pending.length) throw new UiAutomationError('A requisição não contém um novo turno para enviar ao chat web.');

    const selectedPrompt = selectMinimalUiPrompt(pending);
    if (!selectedPrompt) {
      throw new UiAutomationError(
        'O transporte UI não injeta mensagens system/developer/assistant no chat web. Envie um novo turno user (ou tool quando indispensável).'
      );
    }
    if (selectedPrompt.omittedContextMessages > 0 && !this.warnedContextPolicy) {
      this.warnedContextPolicy = true;
      logger.info('Política UI mínima ativa: histórico, system/developer e mensagens assistant não são reinjetados no site; somente o turno user/tool mais recente é enviado.');
    }

    const prompt = selectedPrompt.text;
    const baseline = await collectVisibleSnapshots(this.session.page, this.provider.ui.responseSelectors);
    await this.sendPrompt(prompt);
    const result = await this.awaitResponse(baseline, prompt, options?.onDelta);
    const model = typeof body.model === 'string' && body.model.trim() ? body.model : this.modelId;
    const output = completion(model, result.text);

    if (historyIsPrefix(this.history, incoming)) this.history = [...incoming, { role: 'assistant', text: result.text }];
    else if (incoming.length === 1 && this.history.length) this.history = [...this.history, ...incoming, { role: 'assistant', text: result.text }];
    else this.history = [...incoming, { role: 'assistant', text: result.text }];

    const execution = { completion: output, deltas: computeDeltas(result.snapshots, result.text) };
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
      progressiveUiStreaming: true
    };
  }
}

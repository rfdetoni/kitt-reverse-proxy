import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import { logger } from '../logger.js';
import { messageToText, normalizeMessages } from '../mapping/messages.js';
import type { ProviderPreset } from '../providers/catalog.js';
import { detectBrowserGate, type BrowserGate } from '../security/challenge.js';
import type { AppConfig, ChatExecutionResult, ChatExecutor, JsonObject, OpenAiMessage, OpenAiCompletion, LiveBrowserSession } from '../types.js';
import { anyVisible, firstVisibleLocator, latestVisibleSnapshot, type UiTextSnapshot } from './ui-dom.js';
import { navigateSession } from './browser-session.js';

const POLL_MS = 175;
const MAX_UI_PROMPT_CHARS = 500_000;

interface CanonicalMessage {
  role: string;
  text: string;
}

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

function canonicalMessages(body: JsonObject): CanonicalMessage[] {
  const raw = Array.isArray(body.messages) ? body.messages : [];
  return normalizeMessages(raw).map((message) => ({
    role: message.role,
    text: messageToText(message).trim()
  })).filter((message) => message.text || message.role === 'system');
}

function sameMessage(left: CanonicalMessage, right: CanonicalMessage): boolean {
  return left.role === right.role && left.text === right.text;
}

function historyIsPrefix(history: CanonicalMessage[], incoming: CanonicalMessage[]): boolean {
  return history.length <= incoming.length && history.every((item, index) => {
    const candidate = incoming[index];
    return Boolean(candidate && sameMessage(item, candidate));
  });
}

function formatTurn(messages: CanonicalMessage[]): string {
  if (messages.length === 1 && messages[0]?.role === 'user') return messages[0].text;
  return messages.map((message) => {
    const role = message.role === 'system' || message.role === 'developer' ? 'System' : message.role === 'assistant' ? 'Assistant' : message.role === 'tool' ? 'Tool' : 'User';
    return `${role}:\n${message.text}`;
  }).join('\n\n');
}

function computeDeltas(snapshots: string[], finalText: string): string[] {
  const deltas: string[] = [];
  let accumulated = '';
  for (const raw of [...snapshots, finalText]) {
    const text = raw.trim();
    if (!text || text === accumulated) continue;
    if (text.startsWith(accumulated)) {
      const delta = text.slice(accumulated.length);
      if (delta) deltas.push(delta);
      accumulated = text;
      continue;
    }
    if (accumulated.endsWith(text)) continue;
    deltas.push(text);
    accumulated = text;
  }
  return deltas.length ? deltas : [finalText];
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

    try {
      await input.fill(prompt, { timeout: 5_000 });
    } catch {
      await input.click({ timeout: 5_000 });
      await input.press('ControlOrMeta+A').catch(() => undefined);
      await input.press('Backspace').catch(() => undefined);
      await input.pressSequentially(prompt, { delay: 1, timeout: Math.min(30_000, Math.max(5_000, prompt.length * 2)) });
    }

    const send = await firstVisibleLocator(this.session.page, this.provider.ui.sendSelectors);
    if (send && await send.isEnabled().catch(() => false)) {
      await send.click({ timeout: 5_000 });
      return;
    }
    await input.press('Enter', { timeout: 5_000 });
  }

  private async awaitResponse(baseline: UiTextSnapshot, sentPrompt: string): Promise<{ text: string; snapshots: string[] }> {
    const deadline = Date.now() + this.config.uiResponseTimeoutMs;
    let lastText = '';
    let stableSince = 0;
    const snapshots: string[] = [];

    while (Date.now() < deadline) {
      const gate = await gateMessage(this.session.page, this.provider);
      if (gate) {
        if (!this.config.headed) throw new ManualInterventionRequiredError(`${gate.message} Requer intervenção manual.`);
        await this.waitForReady('desafio de segurança');
      }

      const current = await latestVisibleSnapshot(this.session.page, this.provider.ui.responseSelectors);
      const changed = current.text && (current.count > baseline.count || current.text !== baseline.text || current.selector !== baseline.selector);
      const isPromptEcho = current.text.trim() === sentPrompt.trim();
      if (changed && !isPromptEcho) {
        if (current.text !== lastText) {
          lastText = current.text;
          snapshots.push(current.text);
          stableSince = Date.now();
        }
        const streaming = await anyVisible(this.session.page, this.provider.ui.streamingSelectors);
        if (!streaming && lastText && stableSince > 0 && Date.now() - stableSince >= this.config.uiSettleMs) {
          return { text: lastText, snapshots };
        }
      }
      await sleep(POLL_MS);
    }

    if (lastText) return { text: lastText, snapshots };
    throw new UiAutomationError(`Nenhuma resposta do chat foi detectada em ${Math.round(this.config.uiResponseTimeoutMs / 1000)}s.`);
  }

  private async resetForDivergence(): Promise<void> {
    logger.info('Histórico OpenAI divergiu da conversa web; iniciando uma nova conversa no navegador.');
    await this.reset();
  }

  async reset(): Promise<void> {
    this.history = [];
    const destination = this.provider.ui.newChatUrl || this.config.targetUrl;
    await navigateSession(this.session, destination, this.config.manualInterventionTimeoutMs)
      .catch((error: unknown) => {
        throw new UiAutomationError(`Falha ao iniciar nova conversa: ${error instanceof Error ? error.message : String(error)}`);
      });
    await this.waitForReady('nova conversa');
  }

  private async pendingMessages(incoming: CanonicalMessage[]): Promise<CanonicalMessage[]> {
    if (!this.history.length) return incoming;
    if (historyIsPrefix(this.history, incoming)) {
      const pending = incoming.slice(this.history.length);
      if (pending.length) return pending;
      const lastUser = [...incoming].reverse().find((message) => message.role === 'user' || message.role === 'tool');
      return lastUser ? [lastUser] : [];
    }

    // Some clients submit only the new turn and rely on server-side conversation state.
    if (incoming.length === 1 && ['user', 'tool'].includes(incoming[0]!.role)) return incoming;

    await this.resetForDivergence();
    return incoming;
  }

  async execute(body: JsonObject): Promise<ChatExecutionResult> {
    const incoming = canonicalMessages(body);
    if (!incoming.length) throw new UiAutomationError('Nenhuma mensagem textual utilizável foi recebida.');

    if (body.tools !== undefined && !this.warnedTools) {
      this.warnedTools = true;
      logger.warn('Transporte UI não oferece function calling nativo; tools/tool_choice não são enviados ao site como APIs de ferramenta.');
    }

    const pending = await this.pendingMessages(incoming);
    const prompt = formatTurn(pending);
    const baseline = await latestVisibleSnapshot(this.session.page, this.provider.ui.responseSelectors);
    await this.sendPrompt(prompt);
    const result = await this.awaitResponse(baseline, prompt);
    const model = typeof body.model === 'string' && body.model.trim() ? body.model : this.modelId;
    const output = completion(model, result.text);

    if (historyIsPrefix(this.history, incoming)) this.history = [...incoming, { role: 'assistant', text: result.text }];
    else if (incoming.length === 1 && this.history.length) this.history = [...this.history, ...incoming, { role: 'assistant', text: result.text }];
    else this.history = [...incoming, { role: 'assistant', text: result.text }];

    return { completion: output, deltas: computeDeltas(result.snapshots, result.text) };
  }

  describe(): JsonObject {
    return {
      provider: this.provider.id,
      providerName: this.provider.name,
      transport: 'ui',
      targetOrigin: new URL(this.config.targetUrl).origin,
      persistentSession: this.session.persistent,
      manualChallengeHandling: true
    };
  }
}

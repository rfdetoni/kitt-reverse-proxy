import type { Locator, Page } from 'playwright';
import { RESOURCE_LIMITS } from '../core/resource-limits.js';
import { logger } from '../logger.js';
import type { ProviderPreset } from '../providers/catalog.js';
import { detectBrowserGate, type BrowserGate } from '../security/challenge.js';
import type { AppConfig, LiveBrowserSession } from '../types.js';
import { anyVisible, firstVisibleLocator } from './ui-dom.js';
import { abortableSleep, throwIfAborted } from './cancellation.js';
import { ManualInterventionRequiredError, UiAutomationError } from './ui-errors.js';

function normalizeComposerText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').trim();
}

async function readComposerText(input: Locator): Promise<string> {
  return input.evaluate((element: Element) => {
    if ('value' in element && typeof (element as HTMLInputElement).value === 'string') {
      return (element as HTMLInputElement).value;
    }
    const html = element as HTMLElement;
    return html.innerText || html.textContent || '';
  }).catch(() => '');
}

async function writeComposerText(page: Page, input: Locator, prompt: string): Promise<void> {
  const expected = normalizeComposerText(prompt);

  try {
    await input.fill(prompt, { timeout: 2_000 });
  } catch {
    // Some rich editors do not accept Playwright fill(); retry through the
    // focused keyboard path below.
  }

  if (normalizeComposerText(await readComposerText(input)) === expected) return;

  await input.focus().catch(() => undefined);
  await input.click({ force: true, timeout: 2_000 }).catch(() => undefined);
  await input.press('ControlOrMeta+A').catch(() => undefined);
  await input.press('Backspace').catch(() => undefined);
  await page.keyboard.insertText(prompt);

  const actual = normalizeComposerText(await readComposerText(input));
  if (actual !== expected) {
    throw new UiAutomationError(
      `Falha ao preencher o campo do chat: esperado ${expected.length} caracteres, encontrado ${actual.length}.`
    );
  }
}

async function waitForSubmissionConfirmation(
  session: LiveBrowserSession,
  provider: ProviderPreset,
  input: Locator,
  wasStreaming: boolean,
  signal?: AbortSignal
): Promise<void> {
  const deadline = Date.now() + 1_750;
  while (Date.now() < deadline) {
    throwIfAborted(signal);

    const remaining = normalizeComposerText(await readComposerText(input));
    if (!remaining) return;

    const streamingNow = await anyVisible(session.page, provider.ui.streamingSelectors);
    if (!wasStreaming && streamingNow) return;

    await abortableSleep(100, signal);
  }

  throw new UiAutomationError(
    'O prompt foi preenchido, mas o chat web não confirmou a submissão. Nenhum reenvio automático foi feito para evitar duplicatas.'
  );
}

export async function browserGate(page: Page, provider: ProviderPreset): Promise<BrowserGate | null> {
  return detectBrowserGate(page, provider.ui.inputSelectors);
}

export async function waitForUiReady(
  session: LiveBrowserSession,
  provider: ProviderPreset,
  config: AppConfig,
  reason: string,
  signal?: AbortSignal
): Promise<void> {
  const deadline = Date.now() + config.manualInterventionTimeoutMs;
  let lastGate = '';
  let waitingLogged = false;

  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const input = await firstVisibleLocator(session.page, provider.ui.inputSelectors);
    if (input) return;

    const gate = await browserGate(session.page, provider);
    if (gate) {
      if (!config.headed) {
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
    await abortableSleep(500, signal);
  }

  throw new ManualInterventionRequiredError(
    `Campo de chat não ficou disponível em ${Math.round(config.manualInterventionTimeoutMs / 1000)}s.`
  );
}

export async function sendUiPrompt(
  session: LiveBrowserSession,
  provider: ProviderPreset,
  config: AppConfig,
  prompt: string,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  if (!prompt.trim()) throw new UiAutomationError('Não há conteúdo novo para enviar ao chat web.');
  if (prompt.length > RESOURCE_LIMITS.uiPromptChars) {
    throw new UiAutomationError(`Prompt via UI excede ${RESOURCE_LIMITS.uiPromptChars} caracteres.`);
  }

  await waitForUiReady(session, provider, config, 'envio', signal);
  throwIfAborted(signal);
  const input = await firstVisibleLocator(session.page, provider.ui.inputSelectors);
  if (!input) throw new UiAutomationError('Campo de entrada do chat não foi localizado.');

  const wasStreaming = await anyVisible(session.page, provider.ui.streamingSelectors);
  await writeComposerText(session.page, input, prompt);

  await abortableSleep(150, signal);
  const sendButtonDeadline = Date.now() + 2_500;
  let submitted = false;

  while (Date.now() < sendButtonDeadline) {
    throwIfAborted(signal);
    const send = await firstVisibleLocator(session.page, provider.ui.sendSelectors.map((selector) =>
      `${selector}:not([aria-label*="stop" i]):not([aria-label*="parar" i]):not([aria-label*="interromper" i]):not([data-testid="stop-button"])`
    ));
    if (send && await send.isEnabled().catch(() => false)) {
      await send.click({ timeout: 2_000 });
      submitted = true;
      break;
    }
    await abortableSleep(100, signal);
  }

  if (!submitted) {
    throwIfAborted(signal);
    await input.focus().catch(() => undefined);
    await input.press('Enter', { timeout: 2_000 });
    submitted = true;
  }

  if (!submitted) {
    throw new UiAutomationError('Não foi possível submeter o prompt ao chat web.');
  }

  await waitForSubmissionConfirmation(session, provider, input, wasStreaming, signal);
}

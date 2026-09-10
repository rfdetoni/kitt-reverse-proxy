import type { Page } from 'playwright';
import { RESOURCE_LIMITS } from '../core/resource-limits.js';
import { logger } from '../logger.js';
import type { ProviderPreset } from '../providers/catalog.js';
import { detectBrowserGate, type BrowserGate } from '../security/challenge.js';
import type { AppConfig, LiveBrowserSession } from '../types.js';
import { anyVisible, firstVisibleLocator } from './ui-dom.js';
import { abortableSleep, throwIfAborted } from './cancellation.js';
import { ManualInterventionRequiredError, UiAutomationError } from './ui-errors.js';

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

  await input.focus().catch(() => undefined);
  await input.click({ force: true, timeout: 2_000 }).catch(() => undefined);

  const isContentEditable = await input.getAttribute('contenteditable').catch(() => null);
  if (isContentEditable === 'true' || isContentEditable === '') {
    await input.press('ControlOrMeta+A').catch(() => undefined);
    await input.press('Backspace').catch(() => undefined);
    await session.page.keyboard.insertText(prompt);
  } else {
    try {
      await input.fill(prompt, { timeout: 2_000 });
    } catch {
      await input.press('ControlOrMeta+A').catch(() => undefined);
      await input.press('Backspace').catch(() => undefined);
      await session.page.keyboard.insertText(prompt);
    }
  }

  await abortableSleep(150, signal);
  const sendButtonDeadline = Date.now() + 2_500;
  let submitted = false;

  while (Date.now() < sendButtonDeadline) {
    throwIfAborted(signal);
    const send = await firstVisibleLocator(session.page, provider.ui.sendSelectors);
    if (send && await send.isEnabled().catch(() => false)) {
      await send.click({ force: true, timeout: 2_000 }).catch(() => undefined);
      submitted = true;
      break;
    }
    if (await anyVisible(session.page, provider.ui.streamingSelectors)) {
      submitted = true;
      break;
    }
    await abortableSleep(100, signal);
  }

  if (!submitted) {
    await input.focus().catch(() => undefined);
    await input.press('Enter', { timeout: 2_000 }).catch(() => undefined);
    await session.page.keyboard.press('Enter').catch(() => undefined);
  }

  const verifyDeadline = Date.now() + 1_500;
  while (Date.now() < verifyDeadline) {
    throwIfAborted(signal);
    if (await anyVisible(session.page, provider.ui.streamingSelectors)) return;

    const remainingText = await input.evaluate((element: Element) => {
      if ('value' in element && typeof (element as HTMLInputElement).value === 'string') {
        return (element as HTMLInputElement).value.trim();
      }
      return (element.textContent || '').trim();
    }).catch(() => '');
    if (!remainingText) return;

    const send = await firstVisibleLocator(session.page, provider.ui.sendSelectors);
    if (send && await send.isEnabled().catch(() => false)) {
      await send.click({ force: true, timeout: 1_000 }).catch(() => undefined);
    } else {
      await input.focus().catch(() => undefined);
      await session.page.keyboard.press('Enter').catch(() => undefined);
    }
    await abortableSleep(200, signal);
  }

  throwIfAborted(signal);
}

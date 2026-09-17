import type { Locator, Page } from 'playwright';
import { RESOURCE_LIMITS } from '../core/resource-limits.js';
import { logger } from '../logger.js';
import type { ProviderPreset } from '../providers/catalog.js';
import { detectBrowserGate, type BrowserGate } from '../security/challenge.js';
import type { AppConfig, LiveBrowserSession } from '../types.js';
import { anyVisible, firstVisibleLocator } from './ui-dom.js';
import { abortableSleep, throwIfAborted } from './cancellation.js';
import { ManualInterventionRequiredError, UiAutomationError } from './ui-errors.js';

const EDITABLE_DESCENDANT_SELECTOR = [
  'textarea:not([disabled]):not([readonly])',
  'input:not([type="hidden"]):not([disabled]):not([readonly])',
  '[contenteditable="true"]'
].join(', ');

function normalizeComposerText(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

async function locatorIsEditable(input: Locator): Promise<boolean> {
  return input.evaluate((element: Element) => {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      return !element.disabled && !element.readOnly;
    }
    const html = element as HTMLElement;
    return html.isContentEditable || html.getAttribute('contenteditable') === 'true';
  }).catch(() => false);
}

async function firstEditableLocator(page: Page, selectors: readonly string[]): Promise<Locator | undefined> {
  for (const frame of page.frames().filter((candidate) => !candidate.isDetached())) {
    for (const selector of selectors) {
      try {
        const matches = frame.locator(selector);
        const count = await matches.count();
        for (let index = count - 1; index >= 0; index -= 1) {
          const candidate = matches.nth(index);
          if (!await candidate.isVisible({ timeout: 150 }).catch(() => false)) continue;
          if (await locatorIsEditable(candidate)) return candidate;

          const descendants = candidate.locator(EDITABLE_DESCENDANT_SELECTOR);
          const descendantCount = await descendants.count();
          for (let nestedIndex = descendantCount - 1; nestedIndex >= 0; nestedIndex -= 1) {
            const nested = descendants.nth(nestedIndex);
            if (!await nested.isVisible({ timeout: 150 }).catch(() => false)) continue;
            if (await locatorIsEditable(nested)) return nested;
          }
        }
      } catch {
        // The page can re-render while locating the composer. Try the next candidate.
      }
    }
  }
  return undefined;
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

async function describeComposerTarget(input: Locator): Promise<string> {
  return input.evaluate((element: Element) => {
    const html = element as HTMLElement;
    const id = html.id ? `#${html.id}` : '';
    const role = html.getAttribute('role');
    const editable = html.getAttribute('contenteditable');
    const details = [
      role ? `role=${role}` : '',
      editable !== null ? `contenteditable=${editable}` : ''
    ].filter(Boolean).join(',');
    return `${html.tagName.toLowerCase()}${id}${details ? `[${details}]` : ''}`;
  }).catch(() => 'unknown');
}

async function setComposerTextThroughDom(input: Locator, prompt: string): Promise<void> {
  await input.evaluate((element: Element, text: string) => {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      const prototype = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(element, text);
      else element.value = text;
      element.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType: 'insertText',
        data: text
      }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    const html = element as HTMLElement;
    html.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(html);
    selection?.removeAllRanges();
    selection?.addRange(range);

    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch {
      inserted = false;
    }
    if (!inserted) html.textContent = text;
    html.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      composed: true,
      inputType: 'insertText',
      data: text
    }));
  }, prompt);
}

async function writeComposerText(page: Page, input: Locator, prompt: string): Promise<void> {
  const expected = normalizeComposerText(prompt);

  try {
    await input.fill(prompt, { timeout: 2_000 });
  } catch {
    // Rich editors can reject fill(); continue with an actual focused editor path.
  }

  if (normalizeComposerText(await readComposerText(input)) === expected) return;

  await input.focus().catch(() => undefined);
  await input.click({ force: true, timeout: 2_000 }).catch(() => undefined);
  await input.press('ControlOrMeta+A').catch(() => undefined);
  await input.press('Backspace').catch(() => undefined);
  await page.keyboard.insertText(prompt).catch(() => undefined);

  if (normalizeComposerText(await readComposerText(input)) === expected) return;

  // Lexical/ProseMirror-style editors may expose a visible wrapper or ignore
  // Playwright fill/keyboard insertion. Use the native value setter or an input
  // event on the resolved editable node as a final, non-submitting fallback.
  await setComposerTextThroughDom(input, prompt).catch(() => undefined);

  const actual = normalizeComposerText(await readComposerText(input));
  if (actual !== expected) {
    const target = await describeComposerTarget(input);
    throw new UiAutomationError(
      `Falha ao preencher o campo do chat: esperado ${expected.length} caracteres, encontrado ${actual.length}; alvo=${target}.`
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
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    throwIfAborted(signal);

    const remaining = normalizeComposerText(await readComposerText(input));
    if (!remaining) return;

    const streamingNow = await anyVisible(session.page, provider.ui.streamingSelectors);
    if (!wasStreaming && streamingNow) return;

    await abortableSleep(100, signal);
  }

  // Some rich editors keep their text while the response starts. Response
  // observation below remains authoritative and never resubmits the prompt.
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
    const input = await firstEditableLocator(session.page, provider.ui.inputSelectors);
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
      logger.info(`Aguardando campo de chat editável (${reason}). Se houver login ou consentimento, conclua manualmente no Chromium.`);
      waitingLogged = true;
    }
    await abortableSleep(500, signal);
  }

  throw new ManualInterventionRequiredError(
    `Campo de chat editável não ficou disponível em ${Math.round(config.manualInterventionTimeoutMs / 1000)}s.`
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
  const input = await firstEditableLocator(session.page, provider.ui.inputSelectors);
  if (!input) throw new UiAutomationError('Campo de entrada editável do chat não foi localizado.');

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

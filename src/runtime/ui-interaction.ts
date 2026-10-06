import type { Locator, Page } from 'playwright';
import { RESOURCE_LIMITS } from '../core/resource-limits.js';
import { logger } from '../logger.js';
import type { ProviderPreset } from '../providers/catalog.js';
import { detectBrowserGate, type BrowserGate } from '../security/challenge.js';
import type { AppConfig, LiveBrowserSession } from '../types.js';
import { anyVisible, collectVisibleSnapshots, firstVisibleLocator, selectChangedSnapshot, type UiTextSnapshot } from './ui-dom.js';
import { selectorCandidates, type SelectorCandidate } from './semantic-locator.js';
import { abortableSleep, throwIfAborted } from './cancellation.js';
import { ManualInterventionRequiredError, UiAutomationError } from './ui-errors.js';

const EDITABLE_DESCENDANT_SELECTOR = [
  'textarea:not([disabled]):not([readonly])',
  'input:not([type="hidden"]):not([disabled]):not([readonly])',
  '[contenteditable="true"]'
].join(', ');

interface EditableResolution extends SelectorCandidate {
  locator: Locator;
  frameIndex: number;
}

function normalizeComposerText(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function selectorTargetsEditableElement(selector: string): boolean {
  const normalized = selector.toLowerCase();
  return /(^|[\s>+~,])textarea(?:[\s.#[:]|$)/.test(normalized)
    || /(^|[\s>+~,])input(?:[\s.#[:]|$)/.test(normalized)
    || normalized.includes('[contenteditable="true"]')
    || normalized.includes("[contenteditable='true']");
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

async function firstEditableLocator(page: Page, selectors: readonly string[]): Promise<EditableResolution | undefined> {
  const candidates = selectorCandidates(selectors, 'composer');
  const frames = page.frames().filter((candidate) => !candidate.isDetached());
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const frame = frames[frameIndex]!;
    for (const descriptor of candidates) {
      try {
        const candidate = frame.locator(descriptor.selector).last();
        if (await candidate.count() === 0) continue;
        if (!await candidate.isVisible({ timeout: 150 }).catch(() => false)) continue;

        if (selectorTargetsEditableElement(descriptor.selector) || await locatorIsEditable(candidate)) {
          return { locator: candidate, frameIndex, ...descriptor };
        }

        const descendants = candidate.locator(EDITABLE_DESCENDANT_SELECTOR);
        const descendant = descendants.last();
        if (
          await descendant.count() > 0
          && await descendant.isVisible({ timeout: 150 }).catch(() => false)
          && await locatorIsEditable(descendant)
        ) {
          return { locator: descendant, frameIndex, ...descriptor };
        }
      } catch {
        // The page can re-render while locating the composer. Try the next candidate.
      }
    }
  }
  return undefined;
}

async function readComposerText(input: Locator): Promise<string | undefined> {
  return input.evaluate((element: Element) => {
    if (!element.isConnected) return undefined;
    if ('value' in element && typeof (element as HTMLInputElement).value === 'string') {
      return (element as HTMLInputElement).value;
    }
    const html = element as HTMLElement;
    return html.innerText || html.textContent || '';
  }, undefined, {timeout: 500}).catch(() => undefined);
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

  if (normalizeComposerText(await readComposerText(input) ?? '') === expected) return;

  await input.focus().catch(() => undefined);
  await input.click({ force: true, timeout: 2_000 }).catch(() => undefined);
  await input.press('ControlOrMeta+A').catch(() => undefined);
  await input.press('Backspace').catch(() => undefined);
  await page.keyboard.insertText(prompt).catch(() => undefined);

  if (normalizeComposerText(await readComposerText(input) ?? '') === expected) return;

  await setComposerTextThroughDom(input, prompt).catch(() => undefined);

  const actual = normalizeComposerText(await readComposerText(input) ?? '');
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
  baseline: readonly UiTextSnapshot[],
  prompt: string,
  signal?: AbortSignal
): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + 5_000;
  const streamingSelectors = selectorCandidates(provider.ui.streamingSelectors, 'streaming').map((item) => item.selector);
  let remainingChars: number | undefined;
  while (Date.now() < deadline) {
    throwIfAborted(signal);

    // A detached/unreadable editor is not evidence that the draft was cleared.
    const current = await firstEditableLocator(session.page, provider.ui.inputSelectors);
    const text = current ? await readComposerText(current.locator) : undefined;
    remainingChars = text === undefined ? undefined : normalizeComposerText(text).length;
    let confirmation = remainingChars === 0 ? 'composer_cleared' : '';
    if (!confirmation && await anyVisible(session.page, streamingSelectors)) confirmation = 'generation_started';
    if (!confirmation) {
      const responses = await collectVisibleSnapshots(session.page, provider.ui.responseSelectors);
      if (selectChangedSnapshot(baseline, responses, prompt)) confirmation = 'response_changed';
    }
    if (confirmation) {
      logger.debug('ui.prompt.submission', {
        provider_id: provider.id, outcome: 'confirmed', confirmation,
        wait_ms: Date.now() - startedAt, prompt_chars: prompt.length
      });
      return;
    }

    await abortableSleep(100, signal);
  }
  logger.event('warn', 'ui.prompt.submission', {
    provider_id: provider.id, outcome: 'unconfirmed', wait_ms: Date.now() - startedAt,
    prompt_chars: prompt.length, remaining_chars: remainingChars ?? null
  });
  throw new UiAutomationError('O chat não confirmou o envio do prompt em 5s. Confira o Chromium antes de tentar novamente; o prompt não foi reenviado automaticamente.');
}

export async function browserGate(page: Page, provider: ProviderPreset): Promise<BrowserGate | null> {
  return detectBrowserGate(
    page,
    selectorCandidates(provider.ui.inputSelectors, 'composer').map((item) => item.selector)
  );
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
  signal?: AbortSignal,
  beforeSubmit?: () => void
): Promise<void> {
  throwIfAborted(signal);
  if (!prompt.trim()) throw new UiAutomationError('Não há conteúdo novo para enviar ao chat web.');
  if (prompt.length > RESOURCE_LIMITS.uiPromptChars) {
    throw new UiAutomationError(`Prompt via UI excede ${RESOURCE_LIMITS.uiPromptChars} caracteres.`);
  }

  await waitForUiReady(session, provider, config, 'envio', signal);
  throwIfAborted(signal);
  const resolution = await firstEditableLocator(session.page, provider.ui.inputSelectors);
  if (!resolution) throw new UiAutomationError('Campo de entrada editável do chat não foi localizado.');
  const input = resolution.locator;
  logger.debug('ui.locator.resolved', {
    target: 'composer',
    provider: provider.id,
    selector_version: provider.ui.selectorVersion,
    strategy: resolution.strategy,
    confidence: resolution.confidence,
    selector: resolution.selector,
    frame_index: resolution.frameIndex
  });

  const streamingSelectors = selectorCandidates(provider.ui.streamingSelectors, 'streaming').map((item) => item.selector);
  if (await anyVisible(session.page, streamingSelectors)) {
    throw new UiAutomationError('O chat ainda está gerando uma resposta. Aguarde a conclusão antes de enviar outro prompt.');
  }
  const baseline = await collectVisibleSnapshots(session.page, provider.ui.responseSelectors);
  await writeComposerText(session.page, input, prompt);

  await abortableSleep(150, signal);
  const sendButtonDeadline = Date.now() + 2_500;
  let submitted = false;
  const sendSelectors = selectorCandidates(provider.ui.sendSelectors, 'send').map((item) =>
    `${item.selector}:not([aria-label*="stop" i]):not([aria-label*="parar" i]):not([aria-label*="interromper" i]):not([data-testid="stop-button"])`
  );

  while (Date.now() < sendButtonDeadline) {
    throwIfAborted(signal);
    const send = await firstVisibleLocator(session.page, sendSelectors);
    if (send && await send.isEnabled().catch(() => false)) {
      beforeSubmit?.();
      await send.click({ timeout: 2_000 });
      submitted = true;
      break;
    }
    await abortableSleep(100, signal);
  }

  if (!submitted) {
    throwIfAborted(signal);
    await input.focus().catch(() => undefined);
    beforeSubmit?.();
    await input.press('Enter', { timeout: 2_000 });
  }

  await waitForSubmissionConfirmation(session, provider, baseline, prompt, signal);
}

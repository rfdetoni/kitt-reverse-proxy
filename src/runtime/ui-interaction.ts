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

async function locatorIsEditable(input: Locator): Promise<boolean> {
  return input.evaluate((element: Element) => {
    if (!element.isConnected) return false;
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

        if (await locatorIsEditable(candidate)) {
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

async function composerHasExpectedText(input: Locator, expected: string): Promise<boolean> {
  const rendered = await readComposerText(input);
  if (rendered === undefined) return false;
  if (normalizeComposerText(rendered) === expected) return true;
  // Rich-editor innerText can include layout-only breaks not in the actual draft.
  const raw = await input.evaluate((element: Element) => {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return undefined;
    return (element as HTMLElement).textContent ?? '';
  }, undefined, { timeout: 500 }).catch(() => undefined);
  return typeof raw === 'string' && normalizeComposerText(raw) === expected;
}

async function isNativeComposer(input: Locator): Promise<boolean> {
  return input.evaluate((element: Element) =>
    element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement,
    undefined, { timeout: 500 }
  ).catch(() => false);
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

async function setComposerTextThroughDom(
  input: Locator, prompt: string, replaceRichText = false
): Promise<void> {
  await input.evaluate((element: Element, payload: { text: string; replaceRichText: boolean }) => {
    const { text, replaceRichText } = payload;
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

    // Chromium/React rich editors may autoformat pasted Markdown through
    // fill/insertText, changing the user's characters. A single DOM reset is
    // bounded and must be independently verified before submission.
    let inserted = false;
    if (!replaceRichText) {
      try {
        inserted = document.execCommand('insertText', false, text);
      } catch {
        inserted = false;
      }
    }
    if (!inserted) html.textContent = text;
    html.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      composed: true,
      inputType: 'insertText',
      data: text
    }));
  }, { text: prompt, replaceRichText }, { timeout: prompt.length >= 8_192 ? 10_000 : 5_000 });
}

async function writeComposerText(input: Locator, prompt: string): Promise<void> {
  const expected = normalizeComposerText(prompt);

  const startedAt = Date.now();
  const largePrompt = prompt.length >= 16_384;
  // Browser-rich editors become costly to fill after long conversations.
  // The already verified DOM-replacement path avoids Playwright fill timeouts
  // for medium/large prompts, with no keyboard replay or automatic submission.
  const boundedLargeWrite = prompt.length >= 8_192;
  const native = boundedLargeWrite && await isNativeComposer(input);
  const richDomDirect = boundedLargeWrite && !native;
  const strategy = richDomDirect ? 'rich_dom_direct' : native ? 'native_input' : 'fill';
  let writeFailed = false;
  let writeErrorType = '';
  try {
    if (richDomDirect) {
      await setComposerTextThroughDom(input, prompt, true);
    } else if (native) {
      // For large native textareas, assign the value and dispatch one input
      // event instead of performing a huge browser keyboard/fill operation.
      await setComposerTextThroughDom(input, prompt);
    } else {
      await input.fill(prompt, { timeout: 2_000 });
    }
  } catch (error) {
    writeFailed = true;
    writeErrorType = error instanceof Error ? error.name : 'unknown';
  }

  if (await composerHasExpectedText(input, expected)) {
    // A controlled React editor may replace its value on the next tick.
    // Do not submit merely because one transient read matched.
    if (native) await abortableSleep(100);
    if (richDomDirect) await abortableSleep(250);
    if (await composerHasExpectedText(input, expected)) {
      logger.debug('ui.composer.write', {
        outcome: 'verified', strategy, prompt_chars: prompt.length,
        duration_ms: Date.now() - startedAt, write_failed: writeFailed
      });
      return;
    }
  }

  // A rich editor can append or transform even a small (e.g. 1695-char)
  // tool-result prompt. Attempt one bounded DOM replacement for every length,
  // not only prompts above 8 KiB. Do not retype into an already-corrupted
  // draft: keyboard replay can duplicate content and potentially submit it.
  if (!native && !richDomDirect) {
    await setComposerTextThroughDom(input, prompt, true).catch(() => undefined);
    await abortableSleep(250);
    if (await composerHasExpectedText(input, expected)) {
      await abortableSleep(250);
      if (await composerHasExpectedText(input, expected)) {
        logger.debug('ui.composer.write', {
          outcome: 'verified', strategy: 'rich_dom_replace',
          prompt_chars: prompt.length, duration_ms: Date.now() - startedAt
        });
        return;
      }
    }
  }

  // For native inputs only, a setter-based retry is safe and bounded.
  if (native) {
    await setComposerTextThroughDom(input, prompt, true).catch(() => undefined);
    await abortableSleep(150);
    if (await composerHasExpectedText(input, expected)) {
      await abortableSleep(150);
      if (await composerHasExpectedText(input, expected)) return;
    }
  }

  const actual = normalizeComposerText(await readComposerText(input) ?? '');
  const target = await describeComposerTarget(input);
  logger.event('warn', 'ui.composer.write', {
    outcome: 'integrity_failure', strategy,
    prompt_chars: prompt.length, actual_chars: actual.length,
    duration_ms: Date.now() - startedAt, write_failed: writeFailed,
    write_error_type: writeErrorType || null
  });
  throw new UiAutomationError(
    `Falha ao preencher o campo do chat: esperado ${expected.length} caracteres, encontrado ${actual.length}; alvo=${target}. ${largePrompt ? 'Texto grande não foi redigitado automaticamente.' : 'O texto não foi enviado e não será redigitado automaticamente.'}`
  );
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
      const responses = await collectVisibleSnapshots(session.page, provider.ui.responseSelectors, provider.ui.responseExcludeSelectors);
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

/** Do not edit a draft or snapshot a new turn while an earlier reply is changing. */
export async function waitForUiIdle(
  session: LiveBrowserSession,
  provider: ProviderPreset,
  config: AppConfig,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  const streamingSelectors = selectorCandidates(provider.ui.streamingSelectors, 'streaming').map((item) => item.selector);
  const idleStartedAt = Date.now();
  const idleDeadline = idleStartedAt + Math.max(1_000, config.uiResponseTimeoutMs ?? 180_000);
  let waitingForGeneration = false;
  while (await anyVisible(session.page, streamingSelectors)) {
    throwIfAborted(signal);
    if (Date.now() >= idleDeadline) {
      throw new UiAutomationError('O chat ainda está gerando uma resposta após o prazo de espera. O novo prompt não foi enviado.');
    }
    if (!waitingForGeneration) {
      logger.debug('ui.prompt.waiting_for_generation', {provider_id: provider.id});
      waitingForGeneration = true;
    }
    await abortableSleep(250, signal);
    await waitForUiReady(session, provider, config, 'conclusão da geração anterior', signal);
  }
  if (waitingForGeneration) logger.debug('ui.prompt.generation_idle', {
    provider_id: provider.id, wait_ms: Date.now() - idleStartedAt
  });
  throwIfAborted(signal);
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
  await waitForUiIdle(session, provider, config, signal);
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

  const baseline = await collectVisibleSnapshots(session.page, provider.ui.responseSelectors, provider.ui.responseExcludeSelectors);
  await writeComposerText(input, prompt);

  await abortableSleep(150, signal);
  // A controlled editor can reconcile with an old value after a successful
  // write. A final integrity check prevents accidentally sending that value.
  if (!await composerHasExpectedText(input, normalizeComposerText(prompt))) {
    throw new UiAutomationError('O editor modificou o prompt antes do envio. O texto não foi enviado.');
  }
  const sendButtonDeadline = Date.now() + 2_500;
  let submitted = false;
  const sendSelectors = selectorCandidates(provider.ui.sendSelectors, 'send').map((item) =>
    `${item.selector}:not([aria-label*="stop" i]):not([aria-label*="parar" i]):not([aria-label*="interromper" i]):not([data-testid="stop-button"])`
  );

  while (Date.now() < sendButtonDeadline) {
    throwIfAborted(signal);
    const send = await firstVisibleLocator(session.page, sendSelectors, true);
    if (send) {
      beforeSubmit?.();
      logger.debug('ui.prompt.submission', {provider_id: provider.id, outcome: 'dispatch', method: 'button', prompt_chars: prompt.length});
      try {
        await send.click({ timeout: 2_000 });
      } catch (error) {
        // Playwright can time out after dispatching a click while ChatGPT
        // re-renders the composer. A blind retry may submit twice. Probe the
        // existing accepted/streaming/changed-response signals instead.
        if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error;
        try {
          await waitForSubmissionConfirmation(session, provider, baseline, prompt, signal);
          logger.debug('ui.prompt.submission', {
            provider_id: provider.id, outcome: 'confirmed_after_click_timeout',
            method: 'button', prompt_chars: prompt.length
          });
          return;
        } catch (confirmationError) {
          if (!(confirmationError instanceof UiAutomationError)) throw confirmationError;
          throw new UiAutomationError(
            'O clique expirou e não houve confirmação de envio. ' +
            'O prompt não foi reenviado para evitar duplicação; confira o Chromium.'
          );
        }
      }
      submitted = true;
      break;
    }
    await abortableSleep(100, signal);
  }

  if (!submitted) {
    throwIfAborted(signal);
    await input.focus().catch(() => undefined);
    beforeSubmit?.();
    logger.debug('ui.prompt.submission', {provider_id: provider.id, outcome: 'dispatch', method: 'enter', prompt_chars: prompt.length});
    await input.press('Enter', { timeout: 2_000 });
  }

  await waitForSubmissionConfirmation(session, provider, baseline, prompt, signal);
}

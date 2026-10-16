import type { Page } from 'playwright';
import type { ProviderPreset } from '../providers/catalog.js';
import { throwIfAborted } from './cancellation.js';

export type ContinuationOutcome = 'absent' | 'resumed' | 'manual' | 'paused';

/** Allowed UI-only generation continuation, never a login or approval flow. */
export function isSafeGenerationContinuationLabel(raw: string): boolean {
  const value = raw.trim().replace(/\s+/g, ' ').toLowerCase();
  return value === 'continue' || value === 'continue generating'
    || value === 'continuar' || value === 'continuar gerando'
    || value === 'continuar geração';
}

/**
 * Resume one proven fresh DeepSeek assistant generation without resubmitting
 * the user's prompt. Do not use global buttons, forms, dialogs, or user turns.
 * Requires a new answer snapshot selected against the pre-submit baseline.
 */
export async function resumeDeepseekGeneration(
  page: Page, provider: ProviderPreset, freshAssistantText: string, signal?: AbortSignal,
  allowClick = true
): Promise<ContinuationOutcome> {
  if (provider.id !== 'deepseek' || !freshAssistantText.trim()) return 'absent';
  const url = new URL(page.url());
  if (url.protocol !== 'https:' || url.hostname !== 'chat.deepseek.com') return 'absent';
  throwIfAborted(signal);
  const index = await page.evaluate(({ expected }) => {
    const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim();
    const eligibleLabel = (value: string): boolean => [
      'continue', 'continue generating', 'continuar', 'continuar gerando', 'continuar geração'
    ].includes(normalize(value).toLowerCase());
    const blocks = Array.from(document.querySelectorAll('.ds-assistant-message-main-content')) as HTMLElement[];
    const block = blocks.at(-1);
    if (!block) return -1;
    const current = normalize(block.innerText || block.textContent || '');
    if (!current || current !== normalize(expected)) return -1;
    // The screenshot shows "Servidor está temporariamente indisponível",
    // "Parado" and a footer "Continuar" button BELOW the response content.
    // The footer can be a sibling several wrapper levels away, including a
    // non-native role=button control. Never search outside its assistant card.
    const controlSelector = 'button, [role="button"]';
    const buttons = Array.from(document.querySelectorAll(controlSelector)) as HTMLElement[];
    let ancestor = block.parentElement;
    let stoppedWithServerError = false;
    for (let depth = 0; ancestor && depth < 10; depth++, ancestor = ancestor.parentElement) {
      if (ancestor === document.body || ancestor === document.documentElement
          || ancestor.matches('main, form, dialog, [role="dialog"], [role="alertdialog"]')) break;
      // Stop at any broader thread container (or an unrelated user message).
      // The current assistant card must be the *only* assistant answer here.
      if (ancestor.querySelectorAll('.ds-assistant-message-main-content').length !== 1) break;
      // "Parado" plus "Servidor está temporariamente indisponível" is a
      // provider-side interruption, NOT a finished answer. If the button
      // cannot be located safely, ask the operator instead of returning JSON.
      const surrounding = normalize(ancestor.innerText || ancestor.textContent || '').toLowerCase();
      const expectedLower = normalize(expected).toLowerCase();
      const serverError = surrounding.includes('servidor está temporariamente indisponível')
        || surrounding.includes('server is temporarily unavailable');
      const stopped = /(?:^|\s)(?:parado|stopped)(?:$|\s)/u.test(surrounding);
      stoppedWithServerError ||= serverError && stopped
        && !expectedLower.includes('servidor está temporariamente indisponível')
        && !expectedLower.includes('server is temporarily unavailable');
      const eligible = Array.from(ancestor.querySelectorAll(controlSelector))
        .filter(button => {
          if (button.closest('form, dialog, [role="dialog"], [role="alertdialog"], [data-role="user"], [contenteditable="true"], .ds-markdown, .ds-assistant-message-main-content')) return false;
          const ariaLabel = button.getAttribute('aria-label')?.trim() || '';
          const visibleLabel = button.textContent?.trim() || '';
          if (!eligibleLabel(visibleLabel) && !eligibleLabel(ariaLabel)) return false;
          // Never accept an authorization/login label hidden behind an innocent
          // visible caption, or the reverse.
          if (ariaLabel && !eligibleLabel(ariaLabel)) return false;
          if (button.getAttribute('aria-disabled') === 'true' || button.hasAttribute('disabled')) return false;
          const style = window.getComputedStyle(button);
          const rect = button.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none'
            && rect.width > 0 && rect.height > 0;
        });
      if (eligible.length > 1) return -1; // ambiguous controls: fail closed
      if (eligible.length === 1) return buttons.indexOf(eligible[0]!);
    }
    return stoppedWithServerError ? -2 : -1;
  }, { expected: freshAssistantText }).catch(() => -1);
  if (index === -2) return 'manual';
  if (index < 0) return 'absent';
  const button = page.locator('button, [role="button"]').nth(index);
  if (!await button.isVisible().catch(() => false)) return 'manual';
  const ariaLabel = await button.getAttribute('aria-label').catch(() => null) || '';
  const textLabel = await button.textContent().catch(() => '') || '';
  if (!isSafeGenerationContinuationLabel(textLabel)
      && !isSafeGenerationContinuationLabel(ariaLabel)) return 'manual';
  if (ariaLabel && !isSafeGenerationContinuationLabel(ariaLabel)) return 'manual';
  if (!await button.isEnabled().catch(() => false)) return 'manual';
  if (!allowClick) return 'paused';
  throwIfAborted(signal);
  try {
    await button.click({ timeout: 2_000 });
  } catch {
    return 'manual';
  }
  return 'resumed';
}

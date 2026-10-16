import type { Page } from 'playwright';
import type { ProviderPreset } from '../providers/catalog.js';
import { throwIfAborted } from './cancellation.js';

export type ContinuationOutcome = 'absent' | 'resumed' | 'manual';

/** Allowed UI-only generation continuation, never a login or approval flow. */
export function isSafeGenerationContinuationLabel(raw: string): boolean {
  const value = raw.trim().replace(/\\s+/g, ' ').toLowerCase();
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
  page: Page, provider: ProviderPreset, freshAssistantText: string, signal?: AbortSignal
): Promise<ContinuationOutcome> {
  if (provider.id !== 'deepseek' || !freshAssistantText.trim()) return 'absent';
  const url = new URL(page.url());
  if (url.protocol !== 'https:' || url.hostname !== 'chat.deepseek.com') return 'absent';
  throwIfAborted(signal);
  const index = await page.evaluate(({ expected }) => {
    const normalize = (value: string): string => value.replace(/\\s+/g, ' ').trim();
    const eligibleLabel = (value: string): boolean => [
      'continue', 'continue generating', 'continuar', 'continuar gerando', 'continuar geração'
    ].includes(normalize(value).toLowerCase());
    const blocks = Array.from(document.querySelectorAll('.ds-assistant-message-main-content')) as HTMLElement[];
    const block = blocks.at(-1);
    if (!block) return -1;
    const current = normalize(block.innerText || block.textContent || '');
    if (!current || current !== normalize(expected)) return -1;
    const buttons = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
    let ancestor = block.parentElement;
    // The continuation control must belong to the CURRENT assistant card.
    // Never climb into the entire page, which may contain login/consent UI.
    for (let depth = 0; ancestor && depth < 5; depth++, ancestor = ancestor.parentElement) {
      if (ancestor === document.body || ancestor === document.documentElement
          || ancestor.matches('main, form, dialog, [role="dialog"], [role="alertdialog"]')) break;
      const eligible = Array.from(ancestor.querySelectorAll('button'))
        .filter(button => {
          if (button.closest('form, dialog, [role="dialog"], [role="alertdialog"], [data-role="user"]')) return false;
          const label = button.getAttribute('aria-label') || button.textContent || '';
          if (!eligibleLabel(label)) return false;
          const style = window.getComputedStyle(button);
          const rect = button.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none'
            && rect.width > 0 && rect.height > 0;
        });
      if (eligible.length > 1) return -1;
      if (eligible.length === 1) return buttons.indexOf(eligible[0]!);
    }
    return -1;
  }, { expected: freshAssistantText }).catch(() => -1);
  if (index < 0) return 'absent';
  const button = page.locator('button').nth(index);
  if (!await button.isVisible().catch(() => false)) return 'manual';
  const label = await button.getAttribute('aria-label').catch(() => null)
    || await button.textContent().catch(() => '') || '';
  if (!isSafeGenerationContinuationLabel(label)) return 'manual';
  if (!await button.isEnabled().catch(() => false)) return 'manual';
  throwIfAborted(signal);
  try {
    await button.click({ timeout: 2_000 });
  } catch {
    return 'manual';
  }
  return 'resumed';
}

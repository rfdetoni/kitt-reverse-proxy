import type { Page } from 'playwright';
import { firstVisibleLocator } from './ui-dom.js';
import { throwIfAborted } from './cancellation.js';

/**
 * Exact model names require proof from the logged-in ChatGPT picker.
 * The default chatgpt-web alias remains browser-owned and is never relabeled.
 */
export class ChatGptModelNotVerifiedError extends Error {
  constructor() {
    super('The requested ChatGPT model could not be verified in the browser. Select it manually in ChatGPT or use chatgpt-web.');
    this.name = 'ChatGptModelNotVerifiedError';
  }
}

const EXACT_MODELS = new Set(['gpt-5.6-sol', 'gpt-6-sol', 'gpt-6-astra']);

export function requiredExactChatGptModel(modelId: string): string | undefined {
  const id = modelId.trim().toLowerCase();
  if (EXACT_MODELS.has(id)) return id;
  if (/^gpt[-_]?\d/i.test(id)) throw new ChatGptModelNotVerifiedError();
  return undefined;
}

export function modelRadioMatches(label: string, expected: string): boolean {
  const normalized = label.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/^gpt\s*-?\s*/, 'gpt-');
  return normalized === expected;
}

/** Read the selected model only. No model or reasoning option is changed. */
export async function verifyChatGptModel(
  page: Page, providerId: string, modelId: string, signal?: AbortSignal
): Promise<string | undefined> {
  if (providerId !== 'chatgpt') return undefined;
  const expected = requiredExactChatGptModel(modelId);
  if (!expected) return undefined;
  throwIfAborted(signal);
  const trigger = await firstVisibleLocator(page, [
    'button[data-composer-navigation-target="reasoning"][aria-haspopup="menu"]',
    'button[data-testid="model-switcher-dropdown-button"][aria-haspopup="menu"]',
    'button[aria-haspopup="menu"][data-tone="neutral"]'
  ], true);
  if (!trigger) throw new ChatGptModelNotVerifiedError();
  try {
    await trigger.click({ timeout: 5_000 });
    const surfaces = page.locator(
      '[data-testid="composer-intelligence-picker-content"], ' +
      '[role="menu"]:has([role="menuitemradio"])'
    );
    const visible = [];
    for (const menu of await surfaces.all()) {
      if (await menu.isVisible().catch(() => false)) visible.push(menu);
    }
    if (visible.length !== 1) throw new ChatGptModelNotVerifiedError();
    const menu = visible[0]!;
    const powerView = menu.locator('[data-model-picker-view]');
    if (await powerView.count() === 1 && await powerView.getAttribute('data-model-picker-view') === 'simple') {
      const toggles = menu.locator('[data-model-picker-view-toggle="true"]:not([aria-hidden="true"])');
      if (await toggles.count() !== 1) throw new ChatGptModelNotVerifiedError();
      await toggles.click({ timeout: 5_000 });
    }
    throwIfAborted(signal);
    const selected: string[] = [];
    for (const item of await menu.locator('[role="menuitemradio"][aria-checked="true"]').all()) {
      const label = (await item.getAttribute('aria-label')) || (await item.textContent()) || '';
      const normalized = label.normalize('NFKC').replace(/\s+/g, ' ').trim();
      if (/^(?:GPT[-\s]?)?(?:5\.6|6)\s+(?:Sol|Astra)$/i.test(normalized)) selected.push(normalized);
    }
    if (selected.length !== 1 || !modelRadioMatches(selected[0]!, expected)) {
      throw new ChatGptModelNotVerifiedError();
    }
    return expected;
  } catch {
    throw new ChatGptModelNotVerifiedError();
  } finally {
    await page.keyboard.press('Escape').catch(() => {});
  }
}

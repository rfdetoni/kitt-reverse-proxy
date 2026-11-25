import type { Page } from 'playwright';
import { firstVisibleLocator } from './ui-dom.js';
import { throwIfAborted } from './cancellation.js';

export class ChatGptModelNotVerifiedError extends Error {
  constructor() {
    super('The configured model label could not be verified. Select the exact label manually in ChatGPT.');
    this.name = 'ChatGptModelNotVerifiedError';
  }
}

function normalize(label: string): string {
  return label.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function selectedLabelMatches(labels: string[], expected: string): boolean {
  return labels.length === 1 && Boolean(normalize(expected)) && normalize(labels[0]!) === normalize(expected);
}

/** Verify a visible selected label, not the provider's internal model identity.
 * No model selection, hidden API, or reasoning change is attempted. */
export async function verifyChatGptModelLabel(page: Page, expected: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const trigger = await firstVisibleLocator(page, [
    'button[data-composer-navigation-target="reasoning"][aria-haspopup="menu"]',
    'button[data-testid="model-switcher-dropdown-button"][aria-haspopup="menu"]'
  ], true);
  if (!trigger) throw new ChatGptModelNotVerifiedError();
  try {
    await trigger.click({ timeout: 5000 });
    throwIfAborted(signal);
    const menus = await page.locator('[role="menu"]:has([role="menuitemradio"]), [data-testid="composer-intelligence-picker-content"]').all();
    const visible = [];
    for (const menu of menus) {
      if (await menu.isVisible().catch(() => false)) visible.push(menu);
    }
    if (visible.length !== 1) throw new ChatGptModelNotVerifiedError();
    const labels: string[] = [];
    for (const item of await visible[0]!.locator('[role="menuitemradio"][aria-checked="true"]').all()) {
      if (await item.isVisible().catch(() => false)) {
        labels.push((await item.getAttribute('aria-label')) || (await item.textContent()) || '');
      }
    }
    throwIfAborted(signal);
    if (!selectedLabelMatches(labels, expected)) throw new ChatGptModelNotVerifiedError();
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChatGptModelNotVerifiedError();
  } finally {
    await page.keyboard.press('Escape').catch(() => {});
  }
}

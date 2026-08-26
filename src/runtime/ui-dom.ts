import type { Frame, Locator, Page } from 'playwright';

export interface UiTextSnapshot {
  selector: string;
  count: number;
  text: string;
}

async function visible(locator: Locator): Promise<boolean> {
  try {
    return await locator.isVisible({ timeout: 250 });
  } catch {
    return false;
  }
}

function frames(page: Page): Frame[] {
  return page.frames().filter((frame: Frame) => !frame.isDetached());
}

export async function firstVisibleLocator(page: Page, selectors: readonly string[]): Promise<Locator | undefined> {
  for (const frame of frames(page)) {
    for (const selector of selectors) {
      try {
        const locator = frame.locator(selector).last();
        if (await locator.count() > 0 && await visible(locator)) return locator;
      } catch {
        // UI can mutate while we inspect it; try the next selector/frame.
      }
    }
  }
  return undefined;
}

export async function anyVisible(page: Page, selectors: readonly string[]): Promise<boolean> {
  return Boolean(await firstVisibleLocator(page, selectors));
}

export async function latestVisibleSnapshot(page: Page, selectors: readonly string[]): Promise<UiTextSnapshot> {
  for (const selector of selectors) {
    for (const frame of frames(page)) {
      try {
        const locator = frame.locator(selector);
        const count = await locator.count();
        for (let index = count - 1; index >= Math.max(0, count - 5); index -= 1) {
          const item = locator.nth(index);
          if (!await visible(item)) continue;
          const text = (await item.innerText({ timeout: 500 }).catch(() => '')).trim();
          if (text) return { selector, count, text };
        }
      } catch {
        // Ignore transient DOM/frame errors.
      }
    }
  }
  return { selector: '', count: 0, text: '' };
}

export async function bodyText(page: Page, maxChars = 20_000): Promise<string> {
  try {
    const text = await page.locator('body').innerText({ timeout: 500 });
    return text.slice(0, maxChars);
  } catch {
    return '';
  }
}

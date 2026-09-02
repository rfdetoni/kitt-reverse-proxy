import type { Frame, Locator, Page } from 'playwright';

export interface UiTextSnapshot {
  selector: string;
  frameIndex: number;
  count: number;
  text: string;
}

const EMPTY_SNAPSHOT: UiTextSnapshot = Object.freeze({ selector: '', frameIndex: -1, count: 0, text: '' });
const MAX_SNAPSHOT_CHARS = 2 * 1024 * 1024;

function frames(page: Page): Frame[] {
  return page.frames().filter((frame: Frame) => !frame.isDetached());
}

export async function firstVisibleLocator(page: Page, selectors: readonly string[]): Promise<Locator | undefined> {
  for (const frame of frames(page)) {
    for (const selector of selectors) {
      try {
        const locator = frame.locator(selector).last();
        if (await locator.count() > 0 && await locator.isVisible({ timeout: 150 }).catch(() => false)) {
          return locator;
        }
      } catch {
        // UI can mutate while we inspect it; try the next selector/frame.
      }
    }
  }
  return undefined;
}

export async function anyVisible(page: Page, selectors: readonly string[]): Promise<boolean> {
  try {
    return await page.evaluate((selectorList) => {
      for (const selector of selectorList) {
        try {
          const elements = document.querySelectorAll(selector);
          for (const el of Array.from(elements)) {
            const htmlEl = el as HTMLElement;
            if (htmlEl && (htmlEl.offsetParent !== null || htmlEl.clientHeight > 0 || (htmlEl.getAttribute('aria-hidden') !== 'true' && htmlEl.style.display !== 'none'))) {
              return true;
            }
          }
        } catch {}
      }
      return false;
    }, selectors as string[]);
  } catch {
    return false;
  }
}

export async function collectVisibleSnapshots(page: Page, selectors: readonly string[]): Promise<UiTextSnapshot[]> {
  try {
    const raw = await page.evaluate(({ selectorList, maxChars }) => {
      const results: Array<{ selector: string; frameIndex: number; count: number; text: string }> = [];
      for (const selector of selectorList) {
        try {
          const nodes = Array.from(document.querySelectorAll(selector));
          if (!nodes.length) continue;
          for (let i = nodes.length - 1; i >= Math.max(0, nodes.length - 3); i--) {
            const el = nodes[i] as HTMLElement;
            if (!el) continue;
            const text = (el.innerText || el.textContent || '').trim().slice(0, maxChars);
            if (text) {
              results.push({ selector, frameIndex: 0, count: nodes.length, text });
              break;
            }
          }
        } catch {}
      }
      return results;
    }, { selectorList: selectors as string[], maxChars: MAX_SNAPSHOT_CHARS });
    return raw;
  } catch {
    return [];
  }
}

export function selectChangedSnapshot(
  baseline: readonly UiTextSnapshot[],
  current: readonly UiTextSnapshot[],
  sentPrompt = ''
): UiTextSnapshot | undefined {
  const prompt = sentPrompt.trim();
  let best: { snapshot: UiTextSnapshot; score: number } | undefined;
  for (const snapshot of current) {
    if (!snapshot.text || snapshot.text.trim() === prompt) continue;
    const before = baseline.find((candidate) => candidate.selector === snapshot.selector && candidate.frameIndex === snapshot.frameIndex);
    const countIncrease = before ? snapshot.count > before.count : snapshot.count > 0;
    const textChange = before ? snapshot.text !== before.text : true;
    if (!countIncrease && !textChange) continue;
    let score = 0;
    if (countIncrease) score += 100;
    if (textChange) score += 50;
    score += Math.min(20, snapshot.text.length / 1000);
    if (!best || score > best.score) best = { snapshot, score };
  }
  return best?.snapshot ?? current.find((c) => c.text && c.text.trim() !== prompt);
}

export async function latestVisibleSnapshot(page: Page, selectors: readonly string[]): Promise<UiTextSnapshot> {
  return (await collectVisibleSnapshots(page, selectors))[0] ?? EMPTY_SNAPSHOT;
}

export async function bodyText(page: Page, maxChars = 20_000): Promise<string> {
  try {
    const text = await page.evaluate((max) => (document.body?.innerText || '').slice(0, max), maxChars);
    return text;
  } catch {
    return '';
  }
}

import type { Frame, Locator, Page } from 'playwright';

export interface UiTextSnapshot {
  selector: string;
  frameIndex: number;
  count: number;
  text: string;
}

const EMPTY_SNAPSHOT: UiTextSnapshot = Object.freeze({ selector: '', frameIndex: -1, count: 0, text: '' });
const MAX_SNAPSHOT_CHARS = 2 * 1024 * 1024;

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

export async function collectVisibleSnapshots(page: Page, selectors: readonly string[]): Promise<UiTextSnapshot[]> {
  const output: UiTextSnapshot[] = [];
  const pageFrames = frames(page);
  for (const selector of selectors) {
    for (let frameIndex = 0; frameIndex < pageFrames.length; frameIndex += 1) {
      const frame = pageFrames[frameIndex]!;
      try {
        const locator = frame.locator(selector);
        const count = await locator.count();
        for (let index = count - 1; index >= Math.max(0, count - 5); index -= 1) {
          const item = locator.nth(index);
          if (!await visible(item)) continue;
          const text = (await item.innerText({ timeout: 500 }).catch(() => '')).trim().slice(0, MAX_SNAPSHOT_CHARS);
          if (text) {
            output.push({ selector, frameIndex, count, text });
            break;
          }
        }
      } catch {
        // Ignore transient DOM/frame errors.
      }
    }
  }
  return output;
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
  return best?.snapshot;
}

export async function latestVisibleSnapshot(page: Page, selectors: readonly string[]): Promise<UiTextSnapshot> {
  return (await collectVisibleSnapshots(page, selectors))[0] ?? EMPTY_SNAPSHOT;
}

export async function bodyText(page: Page, maxChars = 20_000): Promise<string> {
  try {
    const text = await page.locator('body').innerText({ timeout: 500 });
    return text.slice(0, maxChars);
  } catch {
    return '';
  }
}

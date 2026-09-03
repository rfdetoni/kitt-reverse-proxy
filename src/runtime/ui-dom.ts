import type { Frame, Locator, Page } from 'playwright';

export interface UiTextSnapshot {
  selector: string;
  frameIndex: number;
  count: number;
  text: string;
  index?: number;
  identity?: string;
  priority?: number;
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
  for (const frame of frames(page)) {
    try {
      const visible = await frame.evaluate((selectorList) => {
        const isVisible = (node: Element): boolean => {
          const element = node as HTMLElement;
          const style = window.getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        for (const selector of selectorList) {
          try {
            for (const element of Array.from(document.querySelectorAll(selector))) {
              if (isVisible(element)) return true;
            }
          } catch {}
        }
        return false;
      }, selectors as string[]);
      if (visible) return true;
    } catch {}
  }
  return false;
}

export async function collectVisibleSnapshots(page: Page, selectors: readonly string[]): Promise<UiTextSnapshot[]> {
  const output: UiTextSnapshot[] = [];
  const pageFrames = frames(page);
  for (let frameIndex = 0; frameIndex < pageFrames.length; frameIndex += 1) {
    const frame = pageFrames[frameIndex]!;
    try {
      const raw = await frame.evaluate(({ selectorList, maxChars }) => {
        const isVisible = (node: Element): boolean => {
          const element = node as HTMLElement;
          const style = window.getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const results: Array<{selector:string;count:number;index:number;identity:string;priority:number;text:string}> = [];
        for (let priority = 0; priority < selectorList.length; priority += 1) {
          const selector = selectorList[priority]!;
          try {
            const nodes = Array.from(document.querySelectorAll(selector));
            for (let index = nodes.length - 1; index >= Math.max(0, nodes.length - 4); index -= 1) {
              const element = nodes[index] as HTMLElement | undefined;
              if (!element || !isVisible(element)) continue;
              const value = (element.innerText || element.textContent || '').trim().slice(0, maxChars);
              if (!value) continue;
              const domIdentity = element.getAttribute('data-message-id') || element.getAttribute('data-turn-id') || element.id || '';
              results.push({
                selector, count: nodes.length, index,
                identity: domIdentity ? `${selector}|${domIdentity}` : `${selector}|index:${index}`,
                priority, text: value
              });
            }
          } catch {}
        }
        return results;
      }, { selectorList: selectors as string[], maxChars: MAX_SNAPSHOT_CHARS });
      for (const snapshot of raw) output.push({ ...snapshot, frameIndex });
      if (frameIndex === 0 && raw.length > 0) break;
    } catch {}
  }
  return output;
}

function comparableText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function sameSnapshotSlot(left: UiTextSnapshot, right: UiTextSnapshot): boolean {
  if (left.identity && right.identity) return left.identity === right.identity && left.frameIndex === right.frameIndex;
  return left.selector === right.selector
    && left.frameIndex === right.frameIndex
    && (left.index ?? -1) === (right.index ?? -1);
}

export function selectChangedSnapshot(
  baseline: readonly UiTextSnapshot[],
  current: readonly UiTextSnapshot[],
  sentPrompt = ''
): UiTextSnapshot | undefined {
  const prompt = comparableText(sentPrompt);
  const baselineTexts = new Set(baseline.map((snapshot) => comparableText(snapshot.text)).filter(Boolean));
  let best: { snapshot: UiTextSnapshot; score: number } | undefined;
  for (const snapshot of current) {
    const value = comparableText(snapshot.text);
    if (!value || value === prompt) continue;
    const before = baseline.find((candidate) => sameSnapshotSlot(candidate, snapshot));
    const countIncrease = before ? snapshot.count > before.count : snapshot.count > 0;
    const textChange = before ? comparableText(snapshot.text) !== comparableText(before.text) : true;
    const newText = !baselineTexts.has(value);
    if (!countIncrease && !textChange && !newText) continue;
    let score = 0;
    const priority = snapshot.priority ?? current.indexOf(snapshot);
    score += Math.max(0, 1000 - priority * 100);
    if (newText) score += 500;
    if (snapshot.identity && !before) score += 300;
    if (countIncrease) score += 200;
    if (textChange) score += 100;
    if (snapshot.index !== undefined && snapshot.index === snapshot.count - 1) score += 50;
    score += Math.min(40, value.length / 500);
    if (!best || score > best.score) best = { snapshot, score };
  }
  return best?.snapshot;
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

export interface ExtractedArtifact {
  filename?: string | undefined;
  language?: string | undefined;
  code: string;
}

export async function extractArtifactContents(page: Page): Promise<ExtractedArtifact[]> {
  const pageFrames = frames(page);
  for (const frame of pageFrames) {
    try {
      const artifacts = await frame.evaluate(() => {
        const results: Array<{ filename?: string | undefined; language?: string | undefined; code: string }> = [];
        const seen = new Set<string>();

        // 1. ChatGPT Canvas / Artifact panels, Claude artifacts, or code containers
        const codeContainers = Array.from(document.querySelectorAll(
          '[class*="canvas" i] pre, [data-testid*="canvas" i] pre, .react-code-text, [class*="artifact" i] pre, article pre'
        ));

        for (const pre of codeContainers) {
          const codeEl = pre.querySelector('code') || pre;
          const text = (codeEl.textContent || '').trim();
          if (!text || seen.has(text)) continue;

          // Attempt to locate title, filename or language indicator in pre parent/header
          let filename: string | undefined;
          let language: string | undefined;

          const header = pre.previousElementSibling || pre.parentElement?.querySelector('header') || pre.querySelector('div:first-child');
          if (header) {
            const headerText = (header.textContent || '').trim();
            const fnMatch = headerText.match(/([a-zA-Z0-9_.-]+\.[a-zA-Z0-9_-]{1,8})/);
            if (fnMatch) filename = fnMatch[1];
          }

          const classAttr = (codeEl.getAttribute('class') || '') + ' ' + (pre.getAttribute('class') || '');
          const langMatch = classAttr.match(/language-([a-zA-Z0-9_-]+)/);
          if (langMatch) language = langMatch[1];

          seen.add(text);
          results.push({ filename, language, code: text });
        }

        // 2. Look for explicit download links or buttons with data or text
        const downloadLinks = Array.from(document.querySelectorAll('a[download], a[href^="blob:"], a[href^="data:"]'));
        for (const link of downloadLinks) {
          const href = link.getAttribute('href') || '';
          const filename = link.getAttribute('download') || (link.textContent || '').trim() || undefined;
          if (href.startsWith('data:') && href.includes(',')) {
            try {
              const [meta, rawData] = href.split(',', 2);
              const isBase64 = meta?.includes(';base64');
              const decoded = isBase64 ? atob(rawData!) : decodeURIComponent(rawData!);
              if (decoded.trim() && !seen.has(decoded.trim())) {
                seen.add(decoded.trim());
                results.push({ filename, code: decoded.trim() });
              }
            } catch {}
          }
        }

        return results;
      });

      if (artifacts.length > 0) return artifacts;
    } catch {}
  }
  return [];
}

import type { Frame, Locator, Page } from 'playwright';
import { parseKAP } from '../contracts/kap.js';

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

export async function firstVisibleLocator(page: Page, selectors: readonly string[], requireEnabled = false): Promise<Locator | undefined> {
  for (const frame of frames(page)) {
    for (const selector of selectors) {
      try {
        const matches = frame.locator(selector);
        const candidates = requireEnabled ? await matches.all() : [matches.last()];
        for (let index = candidates.length - 1; index >= 0; index--) {
          const locator = candidates[index]!;
          if (await locator.count() === 0 || !await locator.isVisible({ timeout: 150 }).catch(() => false)) continue;
          if (requireEnabled && !await locator.isEnabled({ timeout: 150 }).catch(() => false)) continue;
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

export async function readVisibleSnapshotSlot(
  page: Page,
  snapshot: UiTextSnapshot
): Promise<UiTextSnapshot | undefined> {
  const pageFrames = frames(page);
  const frame = pageFrames[snapshot.frameIndex];
  if (!frame || frame.isDetached() || !snapshot.selector) return undefined;
  try {
    const raw = await frame.evaluate(
      ({ selector, index, maxChars }) => {
        const nodes = Array.from(document.querySelectorAll(selector));
        const element = nodes[index] as HTMLElement | undefined;
        if (!element) return undefined;
        const style = window.getComputedStyle(element);
        if (
          style.display === 'none'
          || style.visibility === 'hidden'
          || Number(style.opacity) === 0
        ) {
          return undefined;
        }
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return undefined;
        const text = (element.innerText || element.textContent || '').trim().slice(0, maxChars);
        if (!text) return undefined;
        const domIdentity = element.getAttribute('data-message-id')
          || element.getAttribute('data-turn-id')
          || element.id
          || '';
        return {
          count: nodes.length,
          text,
          identity: domIdentity ? `${selector}|${domIdentity}` : `${selector}|index:${index}`
        };
      },
      {
        selector: snapshot.selector,
        index: snapshot.index ?? Math.max(0, snapshot.count - 1),
        maxChars: MAX_SNAPSHOT_CHARS
      }
    );
    if (!raw) return undefined;
    return {
      ...snapshot,
      count: raw.count,
      text: raw.text,
      identity: raw.identity
    };
  } catch {
    return undefined;
  }
}

/** Fallback for a completed ChatGPT response when markdown selectors are stale.
 * Only inspect assistant-owned containers, never body text or user turns. */
export interface AssistantContractProbe {
  text?: string;
  assistantNodes: number;
  textSamples: number;
  visibleEndMarkers: number;
  structuralTurnNodes: number;
}

export function selectCompletedAssistantContract(
  samples: readonly string[], baseline: readonly UiTextSnapshot[], sentPrompt = ''
): string | undefined {
  const previous = new Set(baseline.map(item => item.text.trim()));
  const valid = new Map<string, string>();
  for (const value of samples) {
    const text = value.trim();
    if (!text || previous.has(text) || (sentPrompt && sentPrompt.includes(text)) ||
        !(text.startsWith('KITT/1') || text.startsWith('K2 '))) continue;
    try {
      const parsed = parseKAP(text);
      const canonical = JSON.stringify(parsed);
      if (!valid.has(canonical)) valid.set(canonical, text);
    } catch { /* Incomplete or UI-transformed text cannot execute as a contract. */ }
  }
  return valid.size === 1 ? [...valid.values()][0] : undefined;
}

export async function inspectCompletedAssistantContract(
  page: Page, baseline: readonly UiTextSnapshot[], sentPrompt = ''
): Promise<AssistantContractProbe> {
  let assistantNodes = 0;
  let structuralTurnNodes = 0;
  let textSamples = 0;
  let visibleEndMarkers = 0;
  const samples: string[] = [];
  for (const frame of frames(page)) {
    try {
      const scan = await frame.evaluate((maxChars) => {
        const roots = Array.from(document.querySelectorAll(
          '[data-message-author-role="assistant"], ' +
          '[data-role="assistant"], [data-testid*="assistant-message"], ' +
          'article[aria-label*="assistant" i], article[aria-label*="chatgpt" i]'
        )) as HTMLElement[];
        const newest = roots[roots.length - 1];
        if (newest) {
          const nodes = [newest, ...Array.from(newest.querySelectorAll(
            'pre, [class*="prose"], [class*="markdown"], [data-testid*="message-content"]'
          ))].slice(-12) as HTMLElement[];
          const texts = nodes.map(node => (node.innerText || node.textContent || '')
            .trim().slice(0, maxChars)).filter(Boolean);
          return { count: roots.length, structural: 0, samples: texts };
        }
        // ChatGPT periodically changes role attributes. Only consider the
        // LAST conversation turn with an assistant-style markdown descendant.
        // Never read the page body, composer, a user-tagged turn or prior turns.
        const turns = Array.from(document.querySelectorAll(
          'main article[data-testid^="conversation-turn"], ' +
          'main [data-testid^="conversation-turn-"]'
        )) as HTMLElement[];
        const latest = turns[turns.length - 1];
        if (!latest || latest.matches('[data-message-author-role="user"], [data-role="user"]')
            || latest.querySelector('[data-message-author-role="user"], [data-role="user"], [data-testid="user-message"]')) {
          return { count: 0, structural: turns.length, samples: [] as string[] };
        }
        const markdown = Array.from(latest.querySelectorAll(
          '.markdown, .prose, [data-testid="message-content"]'
        )) as HTMLElement[];
        const samples = markdown.slice(-8).map(node => (node.innerText || node.textContent || '')
          .trim().slice(0, maxChars)).filter(Boolean);
        return { count: 0, structural: turns.length, samples };
      }, 65_536);
      assistantNodes += scan.count;
      structuralTurnNodes += scan.structural;
      textSamples += scan.samples.length;
      visibleEndMarkers += scan.samples.filter(value => value.includes('KITT/END') || value.includes('K2/END')).length;
      samples.push(...scan.samples);
    } catch { /* Page changes while rendering; next pass can inspect it. */ }
  }
  const text = selectCompletedAssistantContract(samples, baseline, sentPrompt);
  return { ...(text ? { text } : {}), assistantNodes, textSamples,
    visibleEndMarkers, structuralTurnNodes };
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

export function filterNewArtifacts(
  baseline: readonly ExtractedArtifact[],
  current: readonly ExtractedArtifact[]
): ExtractedArtifact[] {
  const previous = new Set(baseline.map((item) => `${item.filename || ''}\0${item.code}`));
  return current.filter((item) => !previous.has(`${item.filename || ''}\0${item.code}`));
}

export async function extractArtifactContents(page: Page): Promise<ExtractedArtifact[]> {
  const pageFrames = frames(page);
  const allResults: ExtractedArtifact[] = [];
  const seenAll = new Set<string>();

  for (const frame of pageFrames) {
    try {
      const artifacts = await frame.evaluate(() => {
        const results: Array<{ filename?: string | undefined; language?: string | undefined; code: string }> = [];
        const seen = new Set<string>();
        let totalChars = 0;

        // 1. ChatGPT Canvas / Artifact panels, Claude artifacts, or code containers
        const codeContainers = Array.from(document.querySelectorAll(
          '[class*="canvas" i] pre, [data-testid*="canvas" i] pre, .react-code-text, [class*="artifact" i] pre, article pre, [class*="code-block" i] pre'
        ));

        for (const pre of codeContainers) {
          const codeEl = pre.querySelector('code') || pre;
          const text = (codeEl.textContent || '');
          if (!text.trim() || seen.has(text) || text.length > 256 * 1024) continue;
          if (results.length >= 16 || totalChars + text.length > 1024 * 1024) break;

          // Locate title, filename or language indicator in pre parent/header
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
          totalChars += text.length;
          results.push({ filename, language, code: text });
        }

        // 2. Look for download buttons, links, or widget anchors (ChatGPT Canvas cards)
        const downloadLinks = Array.from(document.querySelectorAll('a[download], a[href^="blob:"], a[href^="data:"], [data-testid*="download" i]'));
        for (const link of downloadLinks) {
          const href = link.getAttribute('href') || '';
          let filename = link.getAttribute('download') || (link.textContent || '').trim() || undefined;
          if (filename) {
            const fnMatch = filename.match(/([a-zA-Z0-9_.-]+\.[a-zA-Z0-9_-]{1,8})/);
            if (fnMatch) filename = fnMatch[1];
          }

          if (href.startsWith('data:') && href.includes(',')) {
            try {
              const [meta, rawData] = href.split(',', 2);
              if (!rawData || rawData.length > 384 * 1024) continue;
              const isBase64 = meta?.includes(';base64');
              const decoded = (isBase64 ? new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(rawData), char => char.charCodeAt(0))) : decodeURIComponent(rawData));
              if (decoded.trim() && decoded.length <= 256 * 1024 && !seen.has(decoded) && results.length < 16 && totalChars + decoded.length <= 1024 * 1024) {
                seen.add(decoded);
                totalChars += decoded.length;
                results.push({ filename, code: decoded });
              }
            } catch {}
          }
        }

        return results;
      });

      for (const item of artifacts) {
        if (!seenAll.has(item.code)) {
          seenAll.add(item.code);
          allResults.push(item);
        }
      }
    } catch {}
  }

  return allResults;
}

import type { Frame, Locator, Page } from 'playwright';
import { parseKAP } from '../contracts/kap.js';
import { parseContractJson } from '../util/contract-json.js';

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


/**
 * Capture DOM text that actually changed after pre-submit baseline collection.
 * Some WebChat builds have no recognizable assistant nodes; a page-wide text
 * scan then finds only KAP examples inside the long user prompt.
 * These snapshots remain UNTRUSTED until prompt/baseline exclusion and KAP
 * validation. No network hook, host privilege or arbitrary page evaluation.
 */
export async function armFreshContractDomObserver(page: Page): Promise<void> {
  for (const frame of frames(page)) {
    try {
      await frame.evaluate(() => {
        type Capture = { observer: MutationObserver; samples: string[] };
        const holder = window as typeof window & { __kittFreshContractDom?: Capture };
        holder.__kittFreshContractDom?.observer.disconnect();
        if (!document.body) return;
        const samples: string[] = [];
        const isUserOrComposer = (element: Element): boolean => Boolean(element.closest(
          'form, [contenteditable="true"], [role="textbox"], ' +
          '[data-message-author-role="user"], [data-role="user"], [data-testid*="user-message"]'
        ));
        const collect = (initial: Element): void => {
          if (isUserOrComposer(initial)) return;
          let element: Element | null = initial;
          for (let depth = 0; element && depth < 7; depth++, element = element.parentElement) {
            if (element === document.body || element === document.documentElement) break;
            const text = element.textContent?.trim() ?? '';
            if (text.length > 65_536) break; // Ancestors only grow.
            // Tool requests (K2 T) are as important as finals (K2 F).
            // Capture only candidate bytes; host validation still controls authority.
            if (!/(?:^|\s)K2 [TFWQ](?=\s|$)/.test(text) || !text.includes('K2/END')) continue;
            if (!samples.includes(text)) {
              samples.push(text);
              if (samples.length > 24) samples.shift();
            }
            break;
          }
        };
        const observer = new MutationObserver((mutations) => {
          const changed = new Set<Element>();
          for (const mutation of mutations) {
            if (mutation.type === 'characterData' && mutation.target.parentElement)
              changed.add(mutation.target.parentElement);
            if (mutation.type === 'childList') {
              for (const added of Array.from(mutation.addedNodes)) {
                if (added.nodeType === Node.ELEMENT_NODE) changed.add(added as Element);
                else if (added.parentElement) changed.add(added.parentElement);
              }
            }
          }
          // Bound DOM processing even if an unrelated application subtree
          // renders thousands of nodes in one mutation batch.
          for (const element of [...changed].slice(-100)) collect(element);
        });
        observer.observe(document.body, { childList: true, characterData: true, subtree: true });
        holder.__kittFreshContractDom = { observer, samples };
      });
    } catch { /* A navigating/remote frame cannot be observed. */ }
  }
}

export async function stopFreshContractDomObserver(page: Page): Promise<void> {
  for (const frame of frames(page)) {
    try {
      await frame.evaluate(() => {
        const holder = window as typeof window & {
          __kittFreshContractDom?: { observer: MutationObserver; samples: string[] }
        };
        holder.__kittFreshContractDom?.observer.disconnect();
        delete holder.__kittFreshContractDom;
      });
    } catch { /* Frame already navigated. */ }
  }
}

async function recentFreshContractDomSamples(page: Page): Promise<string[]> {
  const samples: string[] = [];
  for (const frame of frames(page)) {
    try {
      const captured = await frame.evaluate(() => {
        const holder = window as typeof window & {
          __kittFreshContractDom?: { samples: string[] }
        };
        return holder.__kittFreshContractDom?.samples.slice(-24) ?? [];
      });
      samples.push(...captured);
    } catch { /* Frame may navigate during output generation. */ }
  }
  return samples.slice(-24);
}

/** Fallback for a completed ChatGPT response when markdown selectors are stale.
 * Fallback page text is untrusted; prompt and pre-submit baselines are excluded. */
export interface AssistantContractProbe {
  text?: string;
  assistantNodes: number;
  textSamples: number;
  visibleEndMarkers: number;
  structuralTurnNodes: number;
  /** Untrusted, fresh but malformed model frame; repair loop must validate. */
  repairText?: string;
  freshVisibleChars?: number;
  compactCandidates?: number;
  freshCompactCandidates?: number;
  maxSampleChars?: number;
  mutationSamples?: number;
}

/**
 * Extract only complete candidate frames. Rendered code blocks may prepend
 * labels, copy controls or fences; a loose K2/END is never sufficient.
 * A frame embedded in the submitted prompt or pre-submit page is not a reply.
 */
export function kapCandidatesFromRenderedText(rendered: string): string[] {
  const text = rendered.replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  const lines = text.split('\n');
  const start = /^(?:K2 [TFWQ](?: [A-Za-z0-9_.:-]{1,64})?|KITT\/1)$/;
  const finish = /^(?:K2\/END|KITT\/END)$/;
  const candidates: string[] = [];
  if (start.test(lines[0] ?? '') && finish.test(lines.at(-1) ?? '')) candidates.push(text);
  // Scan at most the most recent 24 starts to bound work in long conversations.
  const beginnings: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (start.test(lines[i]!.trim())) beginnings.push(i);
  }
  // A newer unfinished frame invalidates an older complete one in the same
  // rendered message: never prematurely accept the first K2/END.
  const latestStart = beginnings.at(-1);
  if (latestStart !== undefined && !lines.slice(latestStart + 1).some(line => finish.test(line.trim()))) {
    return [];
  }
  for (const i of beginnings.slice(-24)) {
    for (let j = i + 1; j < lines.length; j++) {
      if (!finish.test(lines[j]!.trim())) continue;
      const block = lines.slice(i, j + 1).join('\n').trim();
      if (block.length <= 65_536 && !candidates.includes(block)) candidates.push(block);
      break;
    }
  }
  return candidates;
}


/**
 * Extract explicitly tagged KAP/2 compact finals from DOM text. Keep JSON
 * quotes and delimiters intact even if the renderer adds line breaks.
 * This only locates bytes; the Protocol SDK validates the resulting frame.
 */
function compactFinalCandidates(rendered: string): string[] {
  const text = rendered.replace(/\r\n?/g, '\n');
  const found = new Set<string>();
  const starts = [...text.matchAll(/(?:^|\s)K2 F[ \t\n]+@json:[ \t\n]+/g)].slice(-32);
  for (const match of starts) {
    const start = (match.index ?? 0) + (match[0]!.startsWith('K2') ? 0 : 1);
    const opening = (match.index ?? 0) + match[0]!.length;
    if (text[opening] !== '{') continue;
    const stack: string[] = [];
    let quote = false, escaped = false, closeAt = -1;
    for (let i = opening; i < text.length && i - start <= 65_536; i++) {
      const char = text[i]!;
      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quote = false;
        continue;
      }
      if (char === '"') { quote = true; continue; }
      if (char === '{' || char === '[') { stack.push(char); continue; }
      if (char === '}' || char === ']') {
        const opening = stack.pop();
        if (opening !== (char === '}' ? '{' : '[')) break;
        if (!stack.length) { closeAt = i + 1; break; }
      }
    }
    if (closeAt < 0) continue;
    const end = /^[ \t\n]+K2\/END(?=$|\s)/.exec(text.slice(closeAt));
    if (!end) continue;
    const candidate = text.slice(start, closeAt + end[0].length).trim();
    if (new TextEncoder().encode(candidate).length <= 65_536) found.add(candidate);
  }
  return [...found];
}

function strictCompactFinal(candidate: string): string | undefined {
  const match = /^K2 F(?: |\n)@json: (\{[^\n]*\})[ \t\n]+K2\/END$/.exec(candidate);
  if (!match) return undefined;
  const original = match[1]!;
  const valid = (json: string): boolean => {
    try {
      const parsed = parseContractJson(json);
      return !parsed.repaired && parsed.value !== null
        && typeof parsed.value === 'object' && !Array.isArray(parsed.value);
    } catch { return false; }
  };
  if (valid(original)) return candidate;

  // Some Markdown views add a backslash before "_" and "*" inside JSON
  // strings. These are NOT legal JSON escapes: undo only those two known
  // presentation escapes, only inside quotes, and ONLY if the entire result
  // then passes strict JSON validation. Never rewrite proper backslashes.
  let quoted = false, corrections = 0, repaired = '';
  for (let i = 0; i < original.length; i++) {
    const ch = original[i]!;
    if (ch === '"') { quoted = !quoted; repaired += ch; continue; }
    if (quoted && ch === '\\' && i + 1 < original.length) {
      const next = original[i + 1]!;
      if (next === '_' || next === '*') {
        if (++corrections > 32) return undefined;
        repaired += next;
      } else repaired += ch + next;
      i++;
      continue;
    }
    repaired += ch;
  }
  if (!corrections || !valid(repaired)) return undefined;
  return candidate.slice(0, match.index! + match[0].indexOf(original))
    + repaired + candidate.slice(match.index! + match[0].indexOf(original) + original.length);
}

export function selectCompletedAssistantContract(
  samples: readonly string[], baseline: readonly UiTextSnapshot[], sentPrompt = ''
): string | undefined {
  const previous = new Set(baseline.map(item => item.text.trim()));
  const previousVisible = baseline.filter(item => item.selector === '[pre-submit-visible-text]')
    .map(item => item.text);
  const valid = new Map<string, string>();
  // Nested DOM snapshots can contain the same reply multiple times.
  for (const value of new Set(samples)) {
    const candidates = new Set([...kapCandidatesFromRenderedText(value), ...compactFinalCandidates(value)]);
    for (const text of candidates) {
      if (previous.has(text) || previousVisible.some(old => old.includes(text))
          || (sentPrompt && sentPrompt.includes(text))) continue;
      const compact = strictCompactFinal(text);
      if (compact) {
        // Syntax-only recognition. The host validates the canonical KAP/2
        // frame and the result schema; the proxy grants no tool authority.
        valid.set('compact:' + sameVisibleWords(compact), compact);
        continue;
      }
      try {
        const parsed = parseKAP(text);
        const canonical = JSON.stringify(parsed);
        if (!valid.has(canonical)) valid.set(canonical, text);
      } catch { /* Invalid frames must reach host repair, never execute. */ }
    }
  }
  return valid.size === 1 ? [...valid.values()][0] : undefined;
}

/**
 * A stable malformed response must reach the existing contract repair loop
 * instead of turning into a transport timeout. This is NEVER an accepted KAP
 * frame, tool authorization or a provider-side retry.
 *
 * Only the strictly appended part of the visible pre-submit DOM is eligible.
 * The same malformed frame in the prompt, old chat or a competing response
 * fails closed.
 */
/**
 * Locate text after the just-submitted prompt even if the web app
 * virtualized the old conversation. This proves turn freshness, not validity.
 */
function afterSubmittedPrompt(current: string, sentPrompt: string): string | undefined {
  const words = sentPrompt.trim().split(/\s+/).slice(-24);
  if (words.length < 8 || words.join(' ').length < 96) return undefined;
  const escape = (word: string): string => word.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
  const pattern = new RegExp(words.map(escape).join('\\s+'), 'g');
  let end = -1;
  for (const match of current.matchAll(pattern)) {
    end = (match.index ?? -1) + match[0].length;
  }
  return end < 0 ? undefined : current.slice(end).trim();
}

/**
 * A Markdown renderer can replace all line breaks in a generated KAP reply
 * with spaces while retaining its indentation. Extract these delimited,
 * single-line frames only as UNTRUSTED repair input, never as parsed actions.
 * In particular, prompt examples and already-visible answers are not fresh.
 */
function collapsedKapCandidates(rendered: string): string[] {
  const text = rendered.replace(/\r\n?/g, '\n');
  const candidates = new Set<string>();
  const starts = [...text.matchAll(/(?:^|\s)K2 [TFWQ](?=\s)/g)].slice(-32);
  for (const start of starts) {
    const at = (start.index ?? 0) + (start[0]!.startsWith('K2') ? 0 : 1);
    const end = text.indexOf('K2/END', at);
    if (end < 0) continue;
    const candidate = text.slice(at, end + 'K2/END'.length).trim();
    if (candidate.length < 40 || candidate.length > 65_536 || candidate.includes('\n')) continue;
    if ((candidate.match(/\bK2 [TFWQ](?=\s)/g) ?? []).length !== 1
      || candidate.split('K2/END').length !== 2) continue;
    candidates.add(candidate);
  }
  return [...candidates];
}

function sameVisibleWords(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Recover only a fresh, delimited but INVALID envelope for the host-owned
 * repair flow. Never accept malformed text as an authorized tool action.
 */
export function selectFreshRenderedFrameForRepair(
  samples: readonly string[], baseline: readonly UiTextSnapshot[], sentPrompt = ''
): string | undefined {
  const before = baseline.filter(s => s.selector === '[pre-submit-visible-text]')
    .map(s => s.text.replace(/\r\n?/g, '\n').trim()).filter(Boolean);
  const previous = baseline.map(s => s.text.replace(/\r\n?/g, '\n').trim()).filter(Boolean);
  const found = new Set<string>();
  for (const value of samples) {
    const current = value.replace(/\r\n?/g, '\n').trim();
    const regions: string[] = [];
    const fromPrompt = afterSubmittedPrompt(current, sentPrompt);
    if (fromPrompt) regions.push(fromPrompt);

    for (const old of before) {
      let at = current.startsWith(old) ? old.length : -1;
      if (at < 0 && old.length >= 128) {
        const anchor = old.slice(-Math.min(old.length, 512));
        const pos = current.lastIndexOf(anchor);
        if (pos >= 0) at = pos + anchor.length;
      }
      if (at < 0) continue;
      let fresh = current.slice(at).trim();
      if (sentPrompt && fresh.includes(sentPrompt)) {
        fresh = fresh.slice(fresh.lastIndexOf(sentPrompt) + sentPrompt.length).trim();
      } else {
        fresh = afterSubmittedPrompt(fresh, sentPrompt) ?? fresh;
      }
      if (fresh) regions.push(fresh);
    }

    for (const fresh of regions) {
      if (!fresh || sentPrompt.includes(fresh)) continue;
      const framed = [...new Set([...kapCandidatesFromRenderedText(fresh), ...compactFinalCandidates(fresh)])];
      // WebChat can collapse Markdown soft line breaks into a single line.
      // Such a frame is NOT valid KAP; it may only go to host repair, and
      // only if it follows the uniquely identified submitted prompt.
      const collapsed = fromPrompt === fresh && !fresh.includes('\n')
        && /^K2 [TFWQ](?=\s)/.test(fresh)
        && fresh.endsWith('K2/END')
        && (fresh.match(/K2\/END/g) ?? []).length === 1
        ? fresh : undefined;
      const candidates = framed.length === 1 ? framed : collapsed ? [collapsed] : [];
      if (candidates.length !== 1) continue;
      const candidate = candidates[0]!;
      if (new TextEncoder().encode(candidate).length > 65_536
          || sentPrompt.includes(candidate)
          || previous.some(text => text.includes(candidate))) continue;
      try {
        parseKAP(candidate); // Valid frames use the strict completion path.
      } catch {
        found.add(candidate);
      }
    }
  }
  // Some WebChat versions render assistant text as one flat line in main/body,
  // without role-marked nodes, a retained pre-submit baseline, or a matching
  // last-prompt tail. We can still deliver a unique new frame for HOST REPAIR,
  // provided its whitespace-normalized form is absent from the supplied prompt
  // and all pre-submit snapshots. Do not authorize it as a KAP action here.
  const echoed = sameVisibleWords(sentPrompt);
  const oldViews = previous.map(sameVisibleWords);
  for (const sample of samples) {
    for (const candidate of new Set([...collapsedKapCandidates(sample), ...compactFinalCandidates(sample)])) {
      const normalized = sameVisibleWords(candidate);
      if (echoed.includes(normalized) || oldViews.some(old => old.includes(normalized))) continue;
      found.add(candidate);
    }
  }
  return found.size === 1 ? [...found][0] : undefined;
}

/** Snapshot the visible pre-submit conversation so old frames cannot be replayed. */
export async function visibleContractBaseline(page: Page): Promise<string> {
  const pieces: string[] = [];
  for (const frame of frames(page)) {
    try {
      const value = await frame.evaluate(() => {
        const root = document.body || document.querySelector('main, [role="main"], model-response');
        const text = (root as HTMLElement | null)?.innerText || '';
        return text.slice(-131_072);
      });
      if (value) pieces.push(value);
    } catch { /* The frame may be navigating. */ }
  }
  return pieces.join('\n');
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
          'article[aria-label*="assistant" i], article[aria-label*="chatgpt" i], ' +
          'model-response, .model-response-text'
        )) as HTMLElement[];
        const newest = roots[roots.length - 1];
        const responseSamples: string[] = [];
        let structural = 0;
        if (newest) {
          const nodes = [newest, ...Array.from(newest.querySelectorAll(
            'pre, [class*="prose"], [class*="markdown"], [data-testid*="message-content"]'
          ))].slice(-12) as HTMLElement[];
          const texts = nodes.map(node => (node.innerText || node.textContent || '')
            .trim().slice(0, maxChars)).filter(Boolean);
          responseSamples.push(...texts);
        }
        // ChatGPT periodically changes role attributes. Only consider the
        // LAST conversation turn with an assistant-style markdown descendant.
        // Never read the page body, composer, a user-tagged turn or prior turns.
        const turns = Array.from(document.querySelectorAll(
          'main article[data-testid^="conversation-turn"], ' +
          'main [data-testid^="conversation-turn-"]'
        )) as HTMLElement[];
        const latest = turns[turns.length - 1];
        const userOwned = (node: HTMLElement): boolean =>
          Boolean(node.matches('[data-message-author-role="user"], [data-role="user"], [data-testid*="user-message"]')
            || node.querySelector('[data-message-author-role="user"], [data-role="user"], [data-testid*="user-message"]'));
        if (latest && !userOwned(latest)) {
          const markdown = Array.from(latest.querySelectorAll(
            '.markdown, .prose, [data-testid="message-content"], pre'
          )) as HTMLElement[];
          const samples = markdown.slice(-8).map(node => (node.innerText || node.textContent || '')
            .trim().slice(0, maxChars)).filter(Boolean);
          if (samples.length) {
            responseSamples.push(...samples);
            structural = turns.length;
          }
        }
        // Last-resort structural extraction for ChatGPT UI revisions which
        // no longer expose conversation-turn or assistant role attributes.
        // Stay under main, require a reply-format descendant and exclude
        // composers, forms and explicitly user-owned containers. The host
        // subsequently rejects baseline answers, prompt echoes, truncated
        // envelopes and competing KAP frames.
        const replyNodes = Array.from(document.querySelectorAll(
          'main .markdown, main .prose, main [data-testid="message-content"], main article pre'
        )) as HTMLElement[];
        const lastReply = replyNodes[replyNodes.length - 1];
        const owner = lastReply?.closest(
          '[data-message-author-role], [data-role], [data-testid*="user-message"], [data-testid*="conversation-turn"], article'
        ) as HTMLElement | null;
        const notReply = !lastReply
          || Boolean(lastReply.closest('form, [contenteditable="true"], [role="textbox"]'))
          || (owner && (owner.matches('[data-message-author-role="user"], [data-role="user"], [data-testid*="user-message"]')
            || Boolean(owner.querySelector('[data-testid*="user-message"]'))));
        if (!notReply) {
          const text = (lastReply.innerText || lastReply.textContent || '').trim().slice(0, maxChars);
          if (text) {
            responseSamples.push(text);
            structural = Math.max(structural, turns.length || replyNodes.length);
          }
        }

        // The WebChat reply may be rendered in a code block outside the
        // legacy main/assistant nodes. textContent retains the indentation
        // required by KAP/2 structured arrays even when CSS changes innerText.
        for (const code of Array.from(document.querySelectorAll('pre, [role="code"]')).slice(-12)) {
          if (code.closest('form, [contenteditable="true"], [role="textbox"], [data-message-author-role="user"], [data-role="user"]')) continue;
          const text = (code.textContent || '').trim();
          if (text.includes('K2/END') || text.includes('KITT/END')) {
            responseSamples.push(text.slice(-maxChars));
          }
        }
        // Both ChatGPT and Gemini may omit the old assistant role/markdown
        // attributes. A bounded visible snapshot is untrusted evidence;
        // the host extracts a strict frame, excludes the prompt and baseline
        // and rejects multiple distinct valid frames before returning.
        const root = document.querySelector('main, [role="main"], #thread, [data-testid*="conversation"]')
          ?? document.body;
        const visible = (root as HTMLElement | null)?.innerText || '';
        if (visible) responseSamples.push(visible.slice(-131_072));
        // Main and body can differ after UI revisions: a valid assistant
        // response may be portaled outside main while the prompt stays inside.
        const body = document.body?.innerText || '';
        if (body && body !== visible) responseSamples.push(body.slice(-131_072));
        // textContent is only an untrusted fallback when innerText omits
        // a portaled response. All prompt/baseline/freshness checks still apply.
        const rawText = (root as HTMLElement | null)?.textContent || '';
        if (rawText && rawText !== visible && rawText.includes('K2/END'))
          responseSamples.push(rawText.slice(-131_072));
        const rawBody = document.body?.textContent || '';
        if (rawBody && rawBody !== body && rawBody !== rawText && rawBody.includes('K2/END'))
          responseSamples.push(rawBody.slice(-131_072));
        return { count: roots.length, structural: structural || turns.length || replyNodes.length,
          samples: responseSamples };
      }, 65_536);
      assistantNodes += scan.count;
      structuralTurnNodes += scan.structural;
      textSamples += scan.samples.length;
      visibleEndMarkers += scan.samples.filter(value => value.includes('KITT/END') || value.includes('K2/END')).length;
      samples.push(...scan.samples);
    } catch { /* Page changes while rendering; next pass can inspect it. */ }
  }
  const mutationSamples = await recentFreshContractDomSamples(page);
  samples.push(...mutationSamples);
  const uniqueSamples = [...new Set(samples)];
  const text = selectCompletedAssistantContract(uniqueSamples, baseline, sentPrompt);
  const repairText = text ? undefined : selectFreshRenderedFrameForRepair(uniqueSamples, baseline, sentPrompt);
  const compact = new Set(uniqueSamples.flatMap(compactFinalCandidates));
  const beforeText = baseline.map(item => sameVisibleWords(item.text));
  const freshCompactCandidates = [...compact].filter(candidate =>
    !sameVisibleWords(sentPrompt).includes(sameVisibleWords(candidate))
    && beforeText.every(prior => !prior.includes(sameVisibleWords(candidate)))).length;
  const oldVisible = baseline.find(item => item.selector === '[pre-submit-visible-text]')?.text ?? '';
  let freshVisibleChars = 0;
  if (oldVisible) {
    const anchor = oldVisible.slice(-Math.min(oldVisible.length, 512));
    for (const value of uniqueSamples) {
      const pos = anchor ? value.lastIndexOf(anchor) : -1;
      if (pos >= 0) freshVisibleChars = Math.max(freshVisibleChars, value.length - pos - anchor.length);
    }
  }
  return { ...(text ? { text } : {}), ...(repairText ? { repairText } : {}),
    assistantNodes, textSamples, visibleEndMarkers, structuralTurnNodes,
    freshVisibleChars, compactCandidates: compact.size, freshCompactCandidates,
    maxSampleChars: Math.max(0, ...samples.map(sample => sample.length)),
    mutationSamples: mutationSamples.length };
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

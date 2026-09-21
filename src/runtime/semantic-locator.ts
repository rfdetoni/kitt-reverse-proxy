import type { Locator, Page } from 'playwright';

export type SemanticTarget = 'composer' | 'send' | 'streaming' | 'response';

export interface SelectorCandidate {
  selector: string;
  strategy: 'provider' | 'semantic';
  confidence: number;
  priority: number;
}

export interface LocatorResolution {
  locator: Locator;
  selector: string;
  frameIndex: number;
  strategy: SelectorCandidate['strategy'];
  confidence: number;
  priority: number;
}

const FALLBACKS: Readonly<Record<SemanticTarget, readonly string[]>> = Object.freeze({
  composer: Object.freeze([
    '[role="textbox"][contenteditable="true"]',
    '[contenteditable="true"][aria-label*="message" i]',
    '[contenteditable="true"][aria-label*="prompt" i]',
    'textarea:not([disabled]):not([readonly])'
  ]),
  send: Object.freeze([
    'button[type="submit"]:not([disabled])',
    'button[aria-label*="send" i]:not([disabled])',
    'button[aria-label*="enviar" i]:not([disabled])',
    '[role="button"][aria-label*="send" i]'
  ]),
  streaming: Object.freeze([
    '[data-is-streaming="true"]',
    'button[aria-label*="stop" i]',
    'button[aria-label*="parar" i]',
    'button[aria-label*="interromper" i]'
  ]),
  response: Object.freeze([
    '[data-message-author-role="assistant"]',
    '[data-role="assistant"]',
    '[data-testid*="assistant" i]',
    'article'
  ])
});

export function selectorCandidates(
  providerSelectors: readonly string[],
  target: SemanticTarget
): SelectorCandidate[] {
  const output: SelectorCandidate[] = [];
  const seen = new Set<string>();
  const add = (selector: string, strategy: SelectorCandidate['strategy'], confidence: number): void => {
    const normalized = selector.trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    output.push({ selector: normalized, strategy, confidence, priority: output.length });
  };

  providerSelectors.forEach((selector, index) => {
    add(selector, 'provider', Math.max(0.7, 1 - (index * 0.03)));
  });
  FALLBACKS[target].forEach((selector, index) => {
    add(selector, 'semantic', Math.max(0.45, 0.68 - (index * 0.05)));
  });
  return output;
}

export async function resolveVisibleLocator(
  page: Page,
  providerSelectors: readonly string[],
  target: SemanticTarget
): Promise<LocatorResolution | undefined> {
  const candidates = selectorCandidates(providerSelectors, target);
  const frames = page.frames().filter((frame) => !frame.isDetached());
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const frame = frames[frameIndex]!;
    for (const candidate of candidates) {
      try {
        const locator = frame.locator(candidate.selector).last();
        if (await locator.count() === 0) continue;
        if (!await locator.isVisible({ timeout: 150 }).catch(() => false)) continue;
        return { locator, frameIndex, ...candidate };
      } catch {
        // DOM mutation or an unsupported selector should not block the cascade.
      }
    }
  }
  return undefined;
}

export function semanticLocatorContract(): Record<string, unknown> {
  return {
    version: 1,
    strategy_order: ['provider', 'semantic'],
    targets: Object.fromEntries(
      Object.entries(FALLBACKS).map(([target, selectors]) => [target, selectors.length])
    )
  };
}

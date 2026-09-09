import type { Locator, Page } from 'playwright';
import type { ProviderPreset } from '../providers/catalog.js';

export type ReasoningLevel = 'instant' | 'medium' | 'high' | 'extra_high';

export interface ReasoningSelection {
  requestedEffort: number;
  requestedLevel: ReasoningLevel;
  appliedLevel: ReasoningLevel;
  changed: boolean;
  degraded: boolean;
}

export class InvalidReasoningEffortError extends Error {
  constructor(message = 'X-Kitt-Reasoning-Effort deve ser um inteiro entre 0 e 100.') {
    super(message);
    this.name = 'InvalidReasoningEffortError';
  }
}

export class ReasoningNotSupportedError extends Error {
  constructor(provider: string) {
    super(`Controle nativo de reasoning não é suportado pelo provider UI: ${provider}.`);
    this.name = 'ReasoningNotSupportedError';
  }
}

export class ReasoningLevelUnavailableError extends Error {
  constructor(level: ReasoningLevel) {
    super(`O nível de reasoning solicitado não está disponível nesta conta/chat: ${level}.`);
    this.name = 'ReasoningLevelUnavailableError';
  }
}

const LEVEL_LABELS: Record<ReasoningLevel, readonly string[]> = {
  instant: ['Instant', 'Instantâneo', 'Instantaneo'],
  medium: ['Medium', 'Médio', 'Medio'],
  high: ['High', 'Alto'],
  extra_high: ['Extra High', 'Extra-High', 'Extra Alto', 'Extra-Alto', 'Extra alto']
};

const CHATGPT_TRIGGER_SELECTORS = [
  'button[data-testid="model-switcher-dropdown-button"]',
  'button[data-testid*="model-switcher" i]',
  'button[data-testid*="model-picker" i]',
  'button[aria-label*="model" i][aria-haspopup]',
  'button[aria-label*="modelo" i][aria-haspopup]',
  'button[aria-haspopup="menu"]:has-text("Instant")',
  'button[aria-haspopup="menu"]:has-text("Medium")',
  'button[aria-haspopup="menu"]:has-text("High")',
  'button[aria-haspopup="menu"]:has-text("Médio")',
  'button[aria-haspopup="menu"]:has-text("Alto")'
] as const;

const OPTION_SELECTOR = [
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="radio"]',
  '[data-testid*="model-option" i]',
  '[data-radix-menu-content] button',
  '[data-radix-popper-content-wrapper] button'
].join(',');

function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[_–—-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function locatorTextParts(text: string): string[] {
  return text.split('\n').map((part) => part.trim()).filter(Boolean);
}

function levelFromText(value: string): ReasoningLevel | undefined {
  const parts = locatorTextParts(value).map(fold);
  const ordered: ReasoningLevel[] = ['extra_high', 'medium', 'instant', 'high'];
  for (const level of ordered) {
    const labels = LEVEL_LABELS[level].map(fold);
    for (const part of parts) {
      if (labels.some((label) =>
        part === label
        || part.endsWith(` ${label}`)
        || part.startsWith(`${label} `)
        || part.includes(` ${label} `)
      )) {
        return level;
      }
    }
  }
  return undefined;
}

async function locatorText(locator: Locator): Promise<string> {
  const [inner, aria, title] = await Promise.all([
    locator.innerText().catch(() => ''),
    locator.getAttribute('aria-label').catch(() => null),
    locator.getAttribute('title').catch(() => null)
  ]);
  return [inner, aria || '', title || ''].filter(Boolean).join('\n');
}

async function firstVisible(page: Page, selectors: readonly string[]): Promise<Locator | undefined> {
  for (const selector of selectors) {
    const matches = page.locator(selector);
    const count = Math.min(await matches.count().catch(() => 0), 12);
    for (let index = 0; index < count; index += 1) {
      const candidate = matches.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return undefined;
}

export function parseReasoningEffortHeader(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const normalized = value.trim();
  if (!/^\d{1,3}$/.test(normalized)) throw new InvalidReasoningEffortError();
  const effort = Number(normalized);
  if (!Number.isInteger(effort) || effort < 0 || effort > 100) {
    throw new InvalidReasoningEffortError();
  }
  return effort;
}

export function reasoningLevelForEffort(effort: number): ReasoningLevel {
  if (!Number.isInteger(effort) || effort < 0 || effort > 100) {
    throw new InvalidReasoningEffortError();
  }
  if (effort <= 20) return 'instant';
  if (effort <= 60) return 'medium';
  if (effort <= 90) return 'high';
  return 'extra_high';
}

function acceptableLevels(requested: ReasoningLevel): ReasoningLevel[] {
  return requested === 'extra_high' ? ['extra_high', 'high'] : [requested];
}

async function visibleReasoningOption(
  page: Page,
  accepted: readonly ReasoningLevel[]
): Promise<{ locator: Locator; level: ReasoningLevel } | undefined> {
  const candidates = page.locator(OPTION_SELECTOR);
  const count = Math.min(await candidates.count().catch(() => 0), 80);
  for (const level of accepted) {
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (!await candidate.isVisible().catch(() => false)) continue;
      const detected = levelFromText(await locatorText(candidate));
      if (detected === level) return { locator: candidate, level };
    }
  }
  return undefined;
}

export async function applyReasoningEffort(
  page: Page,
  provider: ProviderPreset,
  effort: number
): Promise<ReasoningSelection> {
  const requestedLevel = reasoningLevelForEffort(effort);
  if (provider.id !== 'chatgpt') throw new ReasoningNotSupportedError(provider.id);

  const trigger = await firstVisible(page, CHATGPT_TRIGGER_SELECTORS);
  if (!trigger) throw new ReasoningNotSupportedError(provider.id);

  const currentLevel = levelFromText(await locatorText(trigger));
  if (currentLevel === requestedLevel) {
    return {
      requestedEffort: effort,
      requestedLevel,
      appliedLevel: currentLevel,
      changed: false,
      degraded: false
    };
  }

  await trigger.click({ force: true, timeout: 2_000 });
  await page.waitForTimeout(120);

  const option = await visibleReasoningOption(page, acceptableLevels(requestedLevel));
  if (!option) {
    await page.keyboard.press('Escape').catch(() => undefined);
    throw new ReasoningLevelUnavailableError(requestedLevel);
  }

  await option.locator.click({ force: true, timeout: 2_000 });
  await page.waitForTimeout(120);

  return {
    requestedEffort: effort,
    requestedLevel,
    appliedLevel: option.level,
    changed: option.level !== currentLevel,
    degraded: option.level !== requestedLevel
  };
}

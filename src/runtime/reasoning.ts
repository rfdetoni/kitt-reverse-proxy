import type { Page } from 'playwright';
import type { ProviderPreset } from '../providers/catalog.js';

/**
 * Reasoning level is owned by the authenticated WebChat session.
 *
 * The reverse proxy deliberately does not translate API headers, prompts, or
 * agent settings into WebChat model/reasoning UI changes. These exports remain
 * as compatibility shims for older internal callers while that API surface is
 * phased out.
 */
export type ReasoningLevel = 'instant' | 'medium' | 'high' | 'extra_high';

export interface ReasoningSelection {
  requestedEffort: number;
  requestedLevel: ReasoningLevel;
  appliedLevel: ReasoningLevel;
  changed: boolean;
  degraded: boolean;
}

export class InvalidReasoningEffortError extends Error {
  constructor(message = 'Reasoning effort is managed by WebChat and is not configurable through the reverse proxy.') {
    super(message);
    this.name = 'InvalidReasoningEffortError';
  }
}

export class ReasoningNotSupportedError extends Error {
  constructor(_provider: string) {
    super('Reasoning effort is managed by WebChat and is not configurable through the reverse proxy.');
    this.name = 'ReasoningNotSupportedError';
  }
}

export class ReasoningLevelUnavailableError extends Error {
  constructor(_level: ReasoningLevel) {
    super('Reasoning effort is managed by WebChat and is not configurable through the reverse proxy.');
    this.name = 'ReasoningLevelUnavailableError';
  }
}

/**
 * Legacy compatibility: ignore the header entirely.
 *
 * Returning undefined guarantees that an older client still sending
 * X-Kitt-Reasoning-Effort cannot alter request fingerprints or the WebChat UI.
 */
export function parseReasoningEffortHeader(_value: string | undefined): undefined {
  return undefined;
}

/** Kept for callers/tests that still map legacy values; it has no UI effect. */
export function reasoningLevelForEffort(effort: number): ReasoningLevel {
  const normalized = Number.isFinite(effort) ? Math.max(0, Math.min(100, Math.trunc(effort))) : 0;
  if (normalized <= 20) return 'instant';
  if (normalized <= 60) return 'medium';
  if (normalized <= 90) return 'high';
  return 'extra_high';
}

/**
 * No fallback is performed because selecting any level would override the
 * user's WebChat setting. The requested level is returned only as inert
 * compatibility metadata.
 */
export function reasoningFallbackLevels(requested: ReasoningLevel): ReasoningLevel[] {
  return [requested];
}

export async function applyReasoningEffort(
  _page: Page,
  _provider: ProviderPreset,
  effort: number
): Promise<ReasoningSelection> {
  const requestedLevel = reasoningLevelForEffort(effort);
  return {
    requestedEffort: effort,
    requestedLevel,
    appliedLevel: requestedLevel,
    changed: false,
    degraded: false
  };
}

import type { JsonValue } from '../../types.js';
import { RESOURCE_LIMITS, utf8Bytes } from '../../core/resource-limits.js';
import { appendJsonPath, getPathValues } from '../../util/path.js';

export interface TapTextState {
  text: string;
  score: number;
  samples: number;
  invalid?: boolean;
}

const PREFERRED_KEY_SCORE: Readonly<Record<string, number>> = Object.freeze({
  output_text: 140,
  answer: 130,
  delta: 125,
  text: 120,
  content: 110,
  parts: 100,
  response: 95,
  message: 90
});

const STRUCTURAL_KEYS = new Set([
  'id', 'uuid', 'role', 'type', 'kind', 'status', 'model', 'author', 'sender',
  'content_type', 'finish_reason', 'stop_reason'
]);

function terminalKey(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot >= 0) return path.slice(dot + 1).replace(/(?:\[(?:\*|\d+)\])+$/g, '').toLowerCase();
  const bracket = /\["([^"]+)"\](?:\[\*\])?$/.exec(path);
  return (bracket?.[1] || '').toLowerCase();
}

export function tapPathScore(path: string): number {
  const lower = path.toLowerCase();
  const terminal = terminalKey(path);
  if (STRUCTURAL_KEYS.has(terminal)) return -1;

  let score = PREFERRED_KEY_SCORE[terminal] ?? 0;
  for (const [key, weight] of Object.entries(PREFERRED_KEY_SCORE)) {
    if (lower.includes('.' + key) || lower.includes('["' + key + '"]')) {
      score = Math.max(score, Math.max(10, weight - 35));
    }
  }
  if (/\.(metadata|usage|citations?|attachments?)\b/i.test(lower)) score -= 80;
  return score;
}

interface ExtractionBudget {
  nodes: number;
  decodedBytes: number;
}

export interface TapStringLeaf {
  path: string;
  jsonStringPaths: string[];
  values: string[];
}

function visit(budget: ExtractionBudget, depth: number): void {
  if (++budget.nodes > 8192 || depth > 12) throw new Error('Tap extraction limit exceeded');
}

function decodeJsonString(raw: string, budget: ExtractionBudget): JsonValue | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return undefined;
  const bytes = utf8Bytes(raw);
  if (bytes > RESOURCE_LIMITS.gatewayJsonBytes) throw new Error('Tap encoded JSON limit exceeded');
  budget.decodedBytes += bytes;
  if (budget.decodedBytes > RESOURCE_LIMITS.upstreamResponseBytes) throw new Error('Tap decoding limit exceeded');
  try { return JSON.parse(raw) as JsonValue; } catch { return undefined; }
}

export function collectTapStringLeaves(value: JsonValue): Map<string, TapStringLeaf> {
  const output = new Map<string, TapStringLeaf>();
  const budget: ExtractionBudget = { nodes: 0, decodedBytes: 0 };
  const collect = (child: JsonValue, path: string, depth: number, jsonStringPaths: string[]): void => {
    visit(budget, depth);
    if (typeof child === 'string') {
      const score = tapPathScore(path);
      if (score >= 0) {
        const key = JSON.stringify([...jsonStringPaths, path]);
        if (output.size >= RESOURCE_LIMITS.discoveryCandidates && !output.has(key)) throw new Error('Tap candidate limit exceeded');
        const existing = output.get(key);
        if (existing) existing.values.push(child);
        else output.set(key, { path, jsonStringPaths, values: [child] });
        // Named answer fields contain source text, even when that text is JSON.
        // Decode opaque transport strings only, preserving their original candidate.
        if (score === 0) {
          const decoded = decodeJsonString(child, budget);
          if (decoded !== undefined) collect(decoded, '$', depth + 1, [...jsonStringPaths, path]);
        }
      }
    } else if (Array.isArray(child)) {
      const namedReply = tapPathScore(path) > 0;
      child.forEach((item, index) => collect(item, namedReply ? path + '[*]' : appendJsonPath(path, index), depth + 1, jsonStringPaths));
    } else if (child && typeof child === 'object') {
      for (const [key, item] of Object.entries(child)) collect(item, appendJsonPath(path, key), depth + 1, jsonStringPaths);
    }
  };
  collect(value, '$', 0, []);
  return output;
}

export function tapTextValues(value: JsonValue): string[] {
  const budget: ExtractionBudget = { nodes: 0, decodedBytes: 0 };
  const output: string[] = [];
  const collect = (child: JsonValue, depth: number): void => {
    visit(budget, depth);
    if (typeof child === 'string') output.push(child);
    else if (Array.isArray(child)) child.forEach(item => collect(item, depth + 1));
    else if (child && typeof child === 'object') Object.values(child).forEach(item => collect(item, depth + 1));
  };
  collect(value, 0);
  return output;
}

export function tapProfileValues(value: JsonValue, path: string, jsonStringPaths: string[] = []): string[] {
  if (jsonStringPaths.length > 12) throw new Error('Tap decoding depth exceeded');
  const budget: ExtractionBudget = { nodes: 0, decodedBytes: 0 };
  let decoded = value;
  for (const jsonPath of jsonStringPaths) {
    const values = getPathValues(decoded, jsonPath);
    if (values.length !== 1 || typeof values[0] !== 'string') throw new Error('Tap encoded path changed');
    const next = decodeJsonString(values[0], budget);
    if (next === undefined) throw new Error('Tap encoded JSON changed');
    decoded = next;
  }
  return getPathValues(decoded, path).flatMap(tapTextValues);
}

export function applyTapPiece(state: TapTextState, raw: string, mode: 'delta' | 'snapshot' = 'delta'): string {
  if (!raw || state.invalid) return '';
  state.samples += 1;
  if (mode === 'snapshot') {
    if (!raw.startsWith(state.text)) {
      state.invalid = true;
      return '';
    }
    const delta = raw.slice(state.text.length);
    state.text = raw;
    return delta;
  }
  // Repeated deltas are source data, never evidence of duplicate delivery.
  state.text += raw;
  return raw;
}

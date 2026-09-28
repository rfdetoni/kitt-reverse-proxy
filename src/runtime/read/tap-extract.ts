import type { JsonValue } from '../../types.js';
import { appendJsonPath } from '../../util/path.js';

export interface TapTextState {
  text: string;
  score: number;
  samples: number;
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
  if (dot >= 0) return path.slice(dot + 1).replace(/\[\*\]$/g, '').toLowerCase();
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

export function collectTapStringLeaves(
  value: JsonValue,
  path = '$',
  depth = 0,
  output = new Map<string, string[]>()
): Map<string, string[]> {
  if (depth > 12 || value == null) return output;
  if (typeof value === 'string') {
    const score = tapPathScore(path);
    if (score > 0 || path === '$') {
      const values = output.get(path) ?? [];
      values.push(value);
      output.set(path, values);
    }
    return output;
  }
  if (Array.isArray(value)) {
    for (const child of value.slice(0, 128)) {
      collectTapStringLeaves(child, path + '[*]', depth + 1, output);
    }
    return output;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      collectTapStringLeaves(child, appendJsonPath(path, key), depth + 1, output);
    }
  }
  return output;
}

export function tapTextValues(value: JsonValue): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(tapTextValues);
  if (value && typeof value === 'object') return Object.values(value).flatMap(tapTextValues);
  return [];
}

export function applyTapPiece(state: TapTextState, raw: string): string {
  if (!raw) return '';
  if (!state.text) {
    state.text = raw;
    state.samples += 1;
    return raw;
  }
  if (raw === state.text || state.text.endsWith(raw) || state.text.startsWith(raw)) {
    state.samples += 1;
    return '';
  }
  if (raw.startsWith(state.text)) {
    const delta = raw.slice(state.text.length);
    state.text = raw;
    state.samples += 1;
    return delta;
  }
  state.text += raw;
  state.samples += 1;
  return raw;
}

import type { JsonObject } from '../types.js';
import { messageToText, normalizeMessages } from '../mapping/messages.js';

export interface CanonicalMessage {
  role: string;
  text: string;
}

export function canonicalMessages(body: JsonObject): CanonicalMessage[] {
  const raw = Array.isArray(body.messages) ? body.messages : [];
  return normalizeMessages(raw).map((message) => ({
    role: message.role,
    text: messageToText(message).trim()
  })).filter((message) => message.text || ['system', 'developer'].includes(message.role));
}

export function sameMessage(left: CanonicalMessage, right: CanonicalMessage): boolean {
  return left.role === right.role && left.text === right.text;
}

export function historyIsPrefix(history: CanonicalMessage[], incoming: CanonicalMessage[]): boolean {
  return history.length <= incoming.length && history.every((item, index) => {
    const candidate = incoming[index];
    return Boolean(candidate && sameMessage(item, candidate));
  });
}

export function historyFingerprint(messages: CanonicalMessage[]): string {
  return JSON.stringify(messages.map(({ role, text }) => [role, text]));
}

export interface UiPromptSelection {
  role: 'user' | 'tool';
  text: string;
  omittedContextMessages: number;
}

export function selectMinimalUiPrompt(messages: readonly CanonicalMessage[]): UiPromptSelection | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (!['user', 'tool'].includes(message.role) || !message.text.trim()) continue;
    const text = message.role === 'tool'
      ? message.text.replace(/^\[tool:[^\]]*\]\n?/i, '')
      : message.text;
    return {
      role: message.role as 'user' | 'tool',
      text,
      omittedContextMessages: messages.length - 1
    };
  }
  return undefined;
}

export function deltaFromCumulative(previous: string, current: string): string {
  const before = previous.trim();
  const next = current.trim();
  if (!next || next === before) return '';
  if (!before) return next;
  if (next.startsWith(before)) return next.slice(before.length);
  return '';
}

export function computeDeltas(snapshots: string[], finalText: string): string[] {
  const deltas: string[] = [];
  let accumulated = '';
  for (const raw of [...snapshots, finalText]) {
    const text = raw.trim();
    if (!text || text === accumulated) continue;
    if (text.startsWith(accumulated)) {
      const delta = text.slice(accumulated.length);
      if (delta) deltas.push(delta);
      accumulated = text;
      continue;
    }
    if (accumulated.endsWith(text)) continue;
    // DOM rewrites are not safe to stream as a delta. Keep the final canonical
    // response for the non-streaming result instead of duplicating text.
    accumulated = text;
  }
  if (!deltas.length && finalText) deltas.push(finalText);
  return deltas;
}

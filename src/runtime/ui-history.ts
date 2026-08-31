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

export function formatTurn(messages: CanonicalMessage[]): string {
  if (messages.length === 1 && messages[0]?.role === 'user') return messages[0].text;
  return messages.map((message) => {
    const role = message.role === 'system' || message.role === 'developer'
      ? 'System'
      : message.role === 'assistant'
        ? 'Assistant'
        : message.role === 'tool'
          ? 'Tool'
          : 'User';
    return `${role}:\n${message.text}`;
  }).join('\n\n');
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

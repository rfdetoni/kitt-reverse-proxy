import type { JsonObject } from '../types.js';
import { messageToText, normalizeMessages } from '../mapping/messages.js';

export interface CanonicalMessage {
  role: string;
  text: string;
  toolCallId?: string;
  toolName?: string;
}

export function canonicalMessages(body: JsonObject): CanonicalMessage[] {
  const raw = Array.isArray(body.messages) ? body.messages : [];
  return normalizeMessages(raw).map((message) => ({
    role: message.role,
    text: messageToText(message).trim(),
    ...(typeof message.tool_call_id === 'string' ? { toolCallId: message.tool_call_id } : {}),
    ...(typeof message.name === 'string' ? { toolName: message.name } : {})
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

export function userTurnsAreCompatible(
  history: readonly CanonicalMessage[],
  incoming: readonly CanonicalMessage[]
): boolean {
  const previous = history.filter((message) => message.role === 'user').map((message) => message.text);
  const next = incoming.filter((message) => message.role === 'user').map((message) => message.text);
  if (!previous.length || !next.length) return true;
  const shorter = previous.length <= next.length ? previous : next;
  const longer = previous.length <= next.length ? next : previous;
  return shorter.every((text, index) => longer[index] === text);
}

export function historyFingerprint(messages: CanonicalMessage[]): string {
  return JSON.stringify(messages.map(({ role, text, toolCallId, toolName }) => [
    role,
    text,
    toolCallId || '',
    toolName || ''
  ]));
}

export interface UiPromptSelection {
  role: 'user' | 'tool';
  text: string;
  omittedContextMessages: number;
  toolCallId?: string;
  toolName?: string;
}

export function selectMinimalUiPrompt(messages: readonly CanonicalMessage[]): UiPromptSelection | undefined {
  const message = messages.at(-1);
  if (!message || !['user', 'tool'].includes(message.role) || !message.text.trim()) return undefined;
  const text = message.role === 'tool'
    ? message.text.replace(/^\[tool:[^\]]*\]\n?/i, '')
    : message.text;
  return {
    role: message.role as 'user' | 'tool',
    text,
    omittedContextMessages: messages.length - 1,
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolName ? { toolName: message.toolName } : {})
  };
}

export function selectMinimalUiPrompts(messages: readonly CanonicalMessage[]): UiPromptSelection[] {
  const last = messages.length - 1;
  if (last < 0 || !['user', 'tool'].includes(messages[last]!.role) || !messages[last]!.text.trim()) return [];

  if (messages[last]!.role !== 'tool') {
    const selected = selectMinimalUiPrompt(messages);
    return selected ? [selected] : [];
  }

  let first = last;
  while (first > 0 && messages[first - 1]!.role === 'tool' && messages[first - 1]!.text.trim()) first -= 1;
  return messages.slice(first, last + 1).map((message) => {
    const selected = selectMinimalUiPrompt([message]);
    if (!selected) throw new Error('Falha interna ao normalizar resultado de tool.');
    return { ...selected, omittedContextMessages: messages.length - 1 };
  });
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

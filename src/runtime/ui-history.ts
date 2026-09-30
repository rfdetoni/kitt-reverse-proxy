import type { JsonObject } from '../types.js';
import { messageToText, normalizeMessages } from '../mapping/messages.js';
import { ConversationStateConflictError } from './ui-errors.js';

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

/**
 * Resolve the caller-visible history for a UI execution. Internal control
 * prompts (contract repair, future transport recovery prompts) may be sent to
 * the browser without becoming part of the API conversation history.
 */
export function canonicalLogicalMessages(
  body: JsonObject,
  logicalHistoryBody?: JsonObject
): CanonicalMessage[] {
  return canonicalMessages(logicalHistoryBody ?? body);
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

  // A browser-backed session is stateful. Rewinding or replacing user history must
  // never silently navigate to a fresh chat because that can duplicate side effects.
  if (next.length < previous.length || previous.some((text, index) => next[index] !== text)) {
    throw new ConversationStateConflictError();
  }
  return true;
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

function matchesSelectedPrompt(message: CanonicalMessage, selected: UiPromptSelection): boolean {
  if (message.role !== selected.role) return false;
  if (message.role === 'tool') {
    if (message.toolCallId && selected.toolCallId) return message.toolCallId === selected.toolCallId;
    return message.text.replace(/^\[tool:[^\]]*\]\n?/i, '') === selected.text;
  }
  return message.text === selected.text;
}

function historyRoleLabel(message: CanonicalMessage): string {
  if (message.role === 'user') return 'USER';
  if (message.role === 'assistant') return 'ASSISTANT';
  if (message.role === 'tool') return message.toolName ? `TOOL (${message.toolName})` : 'TOOL';
  return message.role.toUpperCase();
}

/**
 * Materialize API conversation history into a fresh browser-backed chat.
 *
 * Stateful web chats normally retain earlier turns themselves, so replaying the
 * full API history on every request would duplicate context. Hydration is only
 * emitted when the browser executor has no remembered conversation yet. Any
 * trailing actionable message(s) that are about to be sent normally are
 * excluded from the history envelope.
 */
export function buildUiHistoryHydration(
  messages: readonly CanonicalMessage[],
  selectedPrompts: readonly UiPromptSelection[],
  browserHasHistory: boolean
): string {
  if (browserHasHistory || messages.length === 0) return '';

  let contextEnd = messages.length;
  for (let index = selectedPrompts.length - 1; index >= 0 && contextEnd > 0; index -= 1) {
    const selected = selectedPrompts[index]!;
    const candidate = messages[contextEnd - 1]!;
    if (!matchesSelectedPrompt(candidate, selected)) break;
    contextEnd -= 1;
  }

  const context = messages
    .slice(0, contextEnd)
    .filter((message) =>
      !['system', 'developer'].includes(message.role)
      && Boolean(message.text.trim())
    );
  if (context.length === 0) return '';

  const rendered = context
    .map((message) => `${historyRoleLabel(message)}:\n${message.text}`)
    .join('\n\n');
  return [
    '[API CONVERSATION HISTORY]',
    'These are earlier turns from the same API conversation. Use them as context for the current turn and do not answer them again.',
    rendered,
    '[END API CONVERSATION HISTORY]',
    ''
  ].join('\n');
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

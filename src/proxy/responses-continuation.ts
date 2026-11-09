import type { JsonObject, JsonValue, OpenAiCompletion } from '../types.js';
import { responsesBodyToChat } from './openai.js';

interface StoredResponse {
  sessionId: string;
  model: string;
  messages: JsonValue[];
  expiresAt: number;
  bytes: number;
}

const MAX_STORED_BYTES = 16 * 1024 * 1024;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 128;
const TTL_MS = 60 * 60_000;

/**
 * Local-only Responses state. Fail closed for missing or cross-session chains:
 * silently treating a delta as a new conversation loses instructions and tools.
 * No filesystem storage, cookies, credentials or HTTP request headers are retained.
 */
export class ResponsesContinuationStore {
  private readonly entries = new Map<string, StoredResponse>();
  private bytes = 0;

  private remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.entries.delete(id);
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.remove(id);
    }
    while (this.entries.size > MAX_ENTRIES || this.bytes > MAX_STORED_BYTES) {
      const first = this.entries.keys().next().value as string | undefined;
      if (!first) break;
      this.remove(first);
    }
  }

  prepare(source: JsonObject, sessionId: string): JsonObject {
    const current = responsesBodyToChat(source);
    const previousId = source.previous_response_id;
    if (previousId === undefined) return current;
    if (typeof previousId !== 'string') throw new Error('previous_response_id deve ser string.');
    this.prune();
    const prior = this.entries.get(previousId);
    if (!prior || prior.sessionId !== sessionId) {
      throw new Error('previous_response_id desconhecido, expirado ou de outra sessão; reenviar o histórico completo.');
    }
    if (typeof source.model === 'string' && source.model !== prior.model) {
      throw new Error('Não é possível continuar previous_response_id com outro modelo.');
    }
    // Keep the original instructions unless the next turn explicitly replaces them.
    const priorMessages = source.instructions === undefined ? prior.messages
      : prior.messages.filter((message) => !(
        message !== null && typeof message === 'object' && !Array.isArray(message) && message.role === 'system'
      ));
    const currentMessages = current.messages as JsonValue[];
    // The instruction replacement is the first message, never an assistant-following system turn.
    current.messages = source.instructions === undefined
      ? [...priorMessages, ...currentMessages]
      : [...currentMessages.filter((m) => (
          m !== null && typeof m === 'object' && !Array.isArray(m) && m.role === 'system'
        )), ...priorMessages, ...currentMessages.filter((m) => !(
          m !== null && typeof m === 'object' && !Array.isArray(m) && m.role === 'system'
        ))];
    if (current.model === undefined) current.model = prior.model;
    return current;
  }

  remember(responseId: string, source: JsonObject, sessionId: string, chat: JsonObject, completion: OpenAiCompletion): void {
    if (source.store === false) return;
    const last = completion.choices[0]?.message;
    if (!last) return;
    const assistant: JsonObject = { role: 'assistant', content: last.content ?? null };
    if (last.tool_calls?.length) assistant.tool_calls = last.tool_calls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.function.name, arguments: call.function.arguments }
    }));
    const messages: JsonValue[] = [...(chat.messages as JsonValue[]), assistant];
    const bytes = Buffer.byteLength(JSON.stringify(messages), 'utf8');
    if (bytes > MAX_ENTRY_BYTES) return;
    this.remove(responseId);
    this.entries.set(responseId, {
      sessionId,
      model: completion.model,
      messages,
      expiresAt: Date.now() + TTL_MS,
      bytes
    });
    this.bytes += bytes;
    this.prune();
  }
}

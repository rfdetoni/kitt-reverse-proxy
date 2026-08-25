import type { JsonValue, OpenAiMessage } from '../types.js';

export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      const record = part as Record<string, unknown>;
      if (record.type === 'text' && typeof record.text === 'string') return record.text;
      if (typeof record.text === 'string') return record.text;
      if (record.type === 'image_url') return '[image omitted]';
      return '';
    }).filter(Boolean).join('\n');
  }
  return typeof content === 'object' ? JSON.stringify(content) : String(content);
}

export function normalizeMessages(messages: JsonValue[] | undefined): OpenAiMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((value): value is Record<string, JsonValue> => !!value && typeof value === 'object' && !Array.isArray(value))
    .map((message) => ({
      role: typeof message.role === 'string' ? message.role : 'user',
      content: message.content,
      ...(typeof message.name === 'string' ? { name: message.name } : {}),
      ...(typeof message.tool_call_id === 'string' ? { tool_call_id: message.tool_call_id } : {}),
      ...(message.tool_calls !== undefined ? { tool_calls: message.tool_calls } : {})
    }));
}

export function messageToText(message: OpenAiMessage): string {
  const pieces: string[] = [];
  const content = contentToText(message.content);
  if (content) pieces.push(content);
  if (message.tool_calls !== undefined) pieces.push(`[tool calls]\n${JSON.stringify(message.tool_calls)}`);
  if (message.role === 'tool') {
    const label = message.name || message.tool_call_id || 'tool';
    return `[tool:${label}]\n${pieces.join('\n')}`;
  }
  return pieces.join('\n');
}

export function transcript(messages: OpenAiMessage[]): string {
  return messages.map((message) => `${message.role}: ${messageToText(message)}`).join('\n');
}

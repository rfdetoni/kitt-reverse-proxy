import type { JsonObject, JsonValue, OpenAiCompletion } from '../types.js';

const BASE64_PAYLOAD = /data:[^;,\s]+(?:;[^,\s]+)*;base64,[A-Za-z0-9+/=_-]+/gi;

function safeStringify(value: JsonValue | undefined): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value.replace(BASE64_PAYLOAD, '[binary attachment]');
  try {
    return JSON.stringify(value).replace(BASE64_PAYLOAD, '[binary attachment]');
  } catch {
    return '';
  }
}

/**
 * Conservative dependency-free estimate for transports where the upstream UI
 * does not expose tokenizer accounting. It intentionally does not pretend to
 * be provider-exact; consumers can inspect `kitt_estimated`/capabilities.
 */
export function estimateTokenCount(value: string): number {
  const text = value.trim();
  if (!text) return 0;
  const bytes = Buffer.byteLength(text, 'utf8');
  const lexicalUnits = text.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu)?.length ?? 0;
  return Math.max(1, Math.ceil(Math.max(bytes / 4, lexicalUnits * 1.15)));
}

function completionText(completion: OpenAiCompletion): string {
  const message = completion.choices[0]?.message;
  const parts: string[] = [];
  if (typeof message?.content === 'string') parts.push(message.content);
  for (const call of message?.tool_calls ?? []) {
    parts.push(call.function.name, call.function.arguments);
  }
  if (message?.function_call) {
    parts.push(message.function_call.name, message.function_call.arguments);
  }
  return parts.join('\n');
}

function hasUsableUsage(usage: JsonObject | undefined): boolean {
  if (!usage) return false;
  const prompt = usage.prompt_tokens;
  const completion = usage.completion_tokens;
  const total = usage.total_tokens;
  return (
    typeof prompt === 'number' && Number.isFinite(prompt) && prompt >= 0
    && typeof completion === 'number' && Number.isFinite(completion) && completion >= 0
    && typeof total === 'number' && Number.isFinite(total) && total > 0
  );
}

export function withEstimatedUsage(completion: OpenAiCompletion, request: JsonObject): OpenAiCompletion {
  if (hasUsableUsage(completion.usage)) return completion;

  const promptSource = safeStringify(request.messages ?? request.input ?? request);
  const promptTokens = estimateTokenCount(promptSource);
  const completionTokens = estimateTokenCount(completionText(completion));
  return {
    ...completion,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      kitt_estimated: true
    }
  };
}

export function responsesUsage(completion: OpenAiCompletion): JsonObject | undefined {
  const usage = completion.usage;
  if (!usage) return undefined;
  const input = usage.prompt_tokens;
  const output = usage.completion_tokens;
  const total = usage.total_tokens;
  if (typeof input !== 'number' || typeof output !== 'number' || typeof total !== 'number') return undefined;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    ...(usage.kitt_estimated === true ? { kitt_estimated: true } : {})
  };
}

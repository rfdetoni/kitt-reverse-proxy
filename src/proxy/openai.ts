import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { JsonObject, JsonValue, OpenAiCompletion } from '../types.js';
import { isJsonObject, toJsonValue } from '../util/json.js';

export function validateChatBody(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new Error('Body deve ser objeto JSON.');
  if (!Array.isArray(value.messages) || value.messages.length === 0) throw new Error('"messages" deve ser array não vazio.');
  return value;
}

function inputItemToMessage(item: JsonValue): JsonValue | null {
  if (typeof item === 'string') return { role: 'user', content: item };
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const role = typeof item.role === 'string' ? item.role : 'user';
  if ('content' in item) return { role, content: item.content };
  return null;
}

export function responsesBodyToChat(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new Error('Body deve ser objeto JSON.');
  const input = value.input;
  let messages: JsonValue[];
  if (typeof input === 'string') messages = [{ role: 'user', content: input }];
  else if (Array.isArray(input)) messages = input.map(inputItemToMessage).filter((v): v is JsonValue => v !== null);
  else throw new Error('"input" deve ser string ou array.');
  if (!messages.length) throw new Error('"input" não contém mensagens utilizáveis.');
  if (typeof value.instructions === 'string' && value.instructions.trim()) {
    messages.unshift({ role: 'system', content: value.instructions });
  }
  return {
    messages,
    ...(value.model !== undefined ? { model: value.model } : {}),
    ...(value.temperature !== undefined ? { temperature: value.temperature } : {}),
    ...(value.top_p !== undefined ? { top_p: value.top_p } : {}),
    ...(value.max_output_tokens !== undefined ? { max_tokens: value.max_output_tokens } : {}),
    ...(value.tools !== undefined ? { tools: value.tools } : {}),
    ...(value.tool_choice !== undefined ? { tool_choice: value.tool_choice } : {})
  };
}

export function completionToResponses(completion: OpenAiCompletion): JsonObject {
  const text = completion.choices[0]?.message.content || '';
  return toJsonValue({
    id: `resp_${randomUUID()}`,
    object: 'response',
    created_at: completion.created,
    status: 'completed',
    model: completion.model,
    output: [{
      type: 'message',
      id: `msg_${randomUUID()}`,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }]
    }],
    output_text: text
  }) as JsonObject;
}

export function sendOpenAiError(res: Response, status: number, message: string, code = 'proxy_error'): void {
  res.status(status).json({ error: { message, type: 'proxy_error', param: null, code } });
}

export function sendSyntheticChatStream(res: Response, completion: OpenAiCompletion): void {
  res.status(200);
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');
  const content = completion.choices[0]?.message.content || '';
  res.write(`data: ${JSON.stringify({
    id: completion.id,
    object: 'chat.completion.chunk',
    created: completion.created,
    model: completion.model,
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }]
  })}\n\n`);
  res.write(`data: ${JSON.stringify({
    id: completion.id,
    object: 'chat.completion.chunk',
    created: completion.created,
    model: completion.model,
    choices: [{ index: 0, delta: {}, finish_reason: completion.choices[0]?.finish_reason || 'stop' }]
  })}\n\n`);
  res.end('data: [DONE]\n\n');
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function apiKeyMiddleware(apiKey?: string): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    if (!apiKey || req.path === '/healthz') { next(); return; }
    const bearer = req.header('authorization')?.replace(/^Bearer\s+/i, '');
    const supplied = bearer || req.header('x-api-key') || '';
    if (!secureEqual(supplied, apiKey)) {
      sendOpenAiError(res, 401, 'API key local inválida.', 'invalid_api_key');
      return;
    }
    next();
  };
}

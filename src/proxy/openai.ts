import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
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
  if (typeof value.instructions === 'string' && value.instructions.trim()) messages.unshift({ role: 'system', content: value.instructions });
  return {
    messages,
    ...(value.model !== undefined ? { model: value.model } : {}),
    ...(value.temperature !== undefined ? { temperature: value.temperature } : {}),
    ...(value.top_p !== undefined ? { top_p: value.top_p } : {}),
    ...(value.max_output_tokens !== undefined ? { max_completion_tokens: value.max_output_tokens } : {}),
    ...(value.stream !== undefined ? { stream: value.stream } : {}),
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
    error: null,
    incomplete_details: null,
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

function prepareSse(res: Response): void {
  res.status(200);
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('x-accel-buffering', 'no');
  res.flushHeaders?.();
}

export class ChatStreamWriter {
  private readonly id = `chatcmpl-web-${randomUUID()}`;
  private readonly created = Math.floor(Date.now() / 1000);
  private started = false;
  private accumulated = '';

  constructor(private readonly res: Response, private readonly model: string) {}

  begin(): void {
    if (this.started) return;
    this.started = true;
    prepareSse(this.res);
    this.res.write(`data: ${JSON.stringify({
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
    })}\n\n`);
  }

  delta(text: string): void {
    if (!text) return;
    this.begin();
    this.accumulated += text;
    this.res.write(`data: ${JSON.stringify({
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
    })}\n\n`);
  }

  finish(completion: OpenAiCompletion, fallbackDeltas: string[] = []): void {
    this.begin();
    const fullText = completion.choices[0]?.message.content || '';
    if (!this.accumulated) {
      for (const delta of fallbackDeltas.length ? fallbackDeltas : [fullText]) this.delta(delta);
    } else if (fullText.startsWith(this.accumulated)) {
      this.delta(fullText.slice(this.accumulated.length));
    }
    this.res.write(`data: ${JSON.stringify({
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: completion.model || this.model,
      choices: [{ index: 0, delta: {}, finish_reason: completion.choices[0]?.finish_reason || 'stop' }]
    })}\n\n`);
    this.res.end('data: [DONE]\n\n');
  }
}

export class ResponsesStreamWriter {
  private readonly responseId = `resp_${randomUUID()}`;
  private readonly itemId = `msg_${randomUUID()}`;
  private sequence = 0;
  private started = false;
  private accumulated = '';

  constructor(private readonly res: Response, private readonly model: string) {}

  private event(type: string, payload: Record<string, unknown>): void {
    this.sequence += 1;
    this.res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.sequence, ...payload })}\n\n`);
  }

  begin(): void {
    if (this.started) return;
    this.started = true;
    prepareSse(this.res);
    this.event('response.created', {
      response: { id: this.responseId, object: 'response', status: 'in_progress', model: this.model }
    });
    this.event('response.output_item.added', {
      output_index: 0,
      item: { id: this.itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] }
    });
    this.event('response.content_part.added', {
      item_id: this.itemId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] }
    });
  }

  delta(text: string): void {
    if (!text) return;
    this.begin();
    this.accumulated += text;
    this.event('response.output_text.delta', {
      item_id: this.itemId,
      output_index: 0,
      content_index: 0,
      delta: text
    });
  }

  finish(completion: OpenAiCompletion, fallbackDeltas: string[] = []): void {
    this.begin();
    const fullText = completion.choices[0]?.message.content || '';
    if (!this.accumulated) {
      for (const delta of fallbackDeltas.length ? fallbackDeltas : [fullText]) this.delta(delta);
    } else if (fullText.startsWith(this.accumulated)) {
      this.delta(fullText.slice(this.accumulated.length));
    }
    this.event('response.output_text.done', {
      item_id: this.itemId,
      output_index: 0,
      content_index: 0,
      text: fullText,
      logprobs: []
    });
    const part = { type: 'output_text', text: fullText, annotations: [] };
    this.event('response.content_part.done', {
      item_id: this.itemId,
      output_index: 0,
      content_index: 0,
      part
    });
    const item = { id: this.itemId, type: 'message', status: 'completed', role: 'assistant', content: [part] };
    this.event('response.output_item.done', { output_index: 0, item });
    this.event('response.completed', {
      response: {
        id: this.responseId,
        object: 'response',
        created_at: completion.created,
        status: 'completed',
        error: null,
        incomplete_details: null,
        model: completion.model || this.model,
        output: [item],
        output_text: fullText
      }
    });
    this.res.end();
  }
}

export function sendChatStream(res: Response, completion: OpenAiCompletion, deltas?: string[]): void {
  const writer = new ChatStreamWriter(res, completion.model);
  writer.finish(completion, deltas);
}

export function sendResponsesStream(res: Response, completion: OpenAiCompletion, deltas?: string[]): void {
  const writer = new ResponsesStreamWriter(res, completion.model);
  writer.finish(completion, deltas);
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function secureEqual(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right));
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

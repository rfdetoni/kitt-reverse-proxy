import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { JsonObject, JsonValue, OpenAiCompletion } from '../types.js';
import { isJsonObject, toJsonValue } from '../util/json.js';

export function validateChatBody(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new Error('Body deve ser objeto JSON.');
  if (!Array.isArray(value.messages) || value.messages.length === 0) throw new Error('"messages" deve ser array não vazio.');
  return value;
}

function inputItemToMessages(item: JsonValue): JsonValue[] {
  if (typeof item === 'string') return [{ role: 'user', content: item }];
  if (!item || typeof item !== 'object' || Array.isArray(item)) return [];

  if (item.type === 'function_call_output' && typeof item.call_id === 'string') {
    const output = typeof item.output === 'string'
      ? item.output
      : JSON.stringify(item.output ?? '');
    return [{ role: 'tool', tool_call_id: item.call_id, content: output }];
  }

  if (
    item.type === 'function_call'
    && typeof item.call_id === 'string'
    && typeof item.name === 'string'
  ) {
    const argumentsText = typeof item.arguments === 'string'
      ? item.arguments
      : JSON.stringify(item.arguments ?? {});
    return [{
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: item.call_id,
        type: 'function',
        function: { name: item.name, arguments: argumentsText }
      }]
    }];
  }

  if (item.type === 'input_text' && typeof item.text === 'string') {
    return [{ role: 'user', content: item.text }];
  }

  const role = typeof item.role === 'string' ? item.role : 'user';
  if ('content' in item) return [{ role, content: item.content }];
  return [];
}

export function responsesBodyToChat(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new Error('Body deve ser objeto JSON.');
  const input = value.input;
  let messages: JsonValue[];
  if (typeof input === 'string') messages = [{ role: 'user', content: input }];
  else if (Array.isArray(input)) messages = input.flatMap(inputItemToMessages);
  else throw new Error('"input" deve ser string ou array.');
  if (!messages.length) throw new Error('"input" não contém mensagens utilizáveis.');
  if (typeof value.instructions === 'string' && value.instructions.trim()) messages.unshift({ role: 'system', content: value.instructions });
  const responseFormat = value.response_format !== undefined
    ? value.response_format
    : (isJsonObject(value.text) && value.text.format !== undefined ? value.text.format : undefined);

  return {
    messages,
    ...(value.model !== undefined ? { model: value.model } : {}),
    ...(value.temperature !== undefined ? { temperature: value.temperature } : {}),
    ...(value.top_p !== undefined ? { top_p: value.top_p } : {}),
    ...(value.max_output_tokens !== undefined ? { max_completion_tokens: value.max_output_tokens } : {}),
    ...(value.stream !== undefined ? { stream: value.stream } : {}),
    ...(value.tools !== undefined ? { tools: value.tools } : {}),
    ...(value.tool_choice !== undefined ? { tool_choice: value.tool_choice } : {}),
    ...(value.parallel_tool_calls !== undefined ? { parallel_tool_calls: value.parallel_tool_calls } : {}),
    ...(responseFormat !== undefined ? { response_format: responseFormat } : {})
  };
}

export function completionToResponses(
  completion: OpenAiCompletion,
  responseId = `resp_${randomUUID()}`
): JsonObject {
  const message = completion.choices[0]?.message;
  const text = message?.content || '';
  const output: unknown[] = [];

  if (text) {
    output.push({
      type: 'message',
      id: `msg_${randomUUID()}`,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }]
    });
  }

  for (const call of message?.tool_calls || []) {
    output.push({
      id: `fc_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      call_id: call.id,
      type: 'function_call',
      name: call.function.name,
      arguments: call.function.arguments,
      status: 'completed'
    });
  }

  return toJsonValue({
    id: responseId,
    object: 'response',
    created_at: completion.created,
    status: 'completed',
    error: null,
    incomplete_details: null,
    model: completion.model,
    output,
    output_text: text
  }) as JsonObject;
}

export function sendOpenAiError(res: Response, status: number, message: string, code = 'proxy_error'): void {
  if (code === 'session_limit_exceeded') {
    res.status(status).json({ error: 'session_limit_exceeded' });
    return;
  }
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
    const toolCalls = completion.choices[0]?.message.tool_calls;

    if (!this.accumulated) {
      for (const delta of fallbackDeltas.length ? fallbackDeltas : [fullText]) {
        if (delta) this.delta(delta);
      }
    } else if (fullText.startsWith(this.accumulated)) {
      const remaining = fullText.slice(this.accumulated.length);
      if (remaining) this.delta(remaining);
    } else if (fullText.length > this.accumulated.length) {
      let commonLen = 0;
      while (commonLen < this.accumulated.length && commonLen < fullText.length && this.accumulated[commonLen] === fullText[commonLen]) {
        commonLen += 1;
      }
      const remaining = fullText.slice(commonLen);
      if (remaining) this.delta(remaining);
    }

    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      this.res.write(`data: ${JSON.stringify({
        id: this.id,
        object: 'chat.completion.chunk',
        created: this.created,
        model: completion.model || this.model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: toolCalls.map((call, index) => ({
              index,
              id: call.id,
              type: 'function',
              function: {
                name: call.function.name,
                arguments: call.function.arguments
              }
            }))
          },
          finish_reason: null
        }]
      })}\n\n`);
    }

    const legacyFunctionCall = completion.choices[0]?.message.function_call;
    if (legacyFunctionCall) {
      this.res.write(`data: ${JSON.stringify({
        id: this.id,
        object: 'chat.completion.chunk',
        created: this.created,
        model: completion.model || this.model,
        choices: [{
          index: 0,
          delta: { function_call: legacyFunctionCall },
          finish_reason: null
        }]
      })}\n\n`);
    }

    this.res.write(`data: ${JSON.stringify({
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: completion.model || this.model,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: completion.choices[0]?.finish_reason
          || (legacyFunctionCall ? 'function_call' : toolCalls?.length ? 'tool_calls' : 'stop')
      }]
    })}\n\n`);
    this.res.end('data: [DONE]\n\n');
  }
}

export class ResponsesStreamWriter {
  private readonly responseId = `resp_${randomUUID()}`;
  private readonly messageItemId = `msg_${randomUUID()}`;
  private sequence = 0;
  private started = false;
  private messageStarted = false;
  private accumulated = '';

  constructor(private readonly res: Response, private readonly model: string) {}

  private event(type: string, payload: Record<string, unknown>): void {
    this.sequence += 1;
    this.res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.sequence, ...payload })}\n\n`);
  }

  private beginResponse(): void {
    if (this.started) return;
    this.started = true;
    prepareSse(this.res);
    this.event('response.created', {
      response: { id: this.responseId, object: 'response', status: 'in_progress', model: this.model }
    });
  }

  private beginMessage(): void {
    this.beginResponse();
    if (this.messageStarted) return;
    this.messageStarted = true;
    this.event('response.output_item.added', {
      output_index: 0,
      item: { id: this.messageItemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] }
    });
    this.event('response.content_part.added', {
      item_id: this.messageItemId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] }
    });
  }

  delta(text: string): void {
    if (!text) return;
    this.beginMessage();
    this.accumulated += text;
    this.event('response.output_text.delta', {
      item_id: this.messageItemId,
      output_index: 0,
      content_index: 0,
      delta: text
    });
  }

  finish(completion: OpenAiCompletion, fallbackDeltas: string[] = []): void {
    this.beginResponse();
    const fullText = completion.choices[0]?.message.content || '';
    const toolCalls = completion.choices[0]?.message.tool_calls || [];
    const output: unknown[] = [];
    let outputIndex = 0;

    if (fullText) {
      if (!this.accumulated) {
        for (const delta of fallbackDeltas.length ? fallbackDeltas : [fullText]) {
          if (delta) this.delta(delta);
        }
      } else if (fullText.startsWith(this.accumulated)) {
        this.delta(fullText.slice(this.accumulated.length));
      }

      const part = { type: 'output_text', text: fullText, annotations: [] };
      this.event('response.output_text.done', {
        item_id: this.messageItemId,
        output_index: outputIndex,
        content_index: 0,
        text: fullText,
        logprobs: []
      });
      this.event('response.content_part.done', {
        item_id: this.messageItemId,
        output_index: outputIndex,
        content_index: 0,
        part
      });
      const item = {
        id: this.messageItemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [part]
      };
      this.event('response.output_item.done', { output_index: outputIndex, item });
      output.push(item);
      outputIndex += 1;
    }

    for (const call of toolCalls) {
      const itemId = `fc_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const added = {
        id: itemId,
        call_id: call.id,
        type: 'function_call',
        name: call.function.name,
        arguments: '',
        status: 'in_progress'
      };
      this.event('response.output_item.added', { output_index: outputIndex, item: added });
      this.event('response.function_call_arguments.delta', {
        item_id: itemId,
        output_index: outputIndex,
        delta: call.function.arguments
      });
      this.event('response.function_call_arguments.done', {
        item_id: itemId,
        output_index: outputIndex,
        arguments: call.function.arguments
      });
      const done = { ...added, arguments: call.function.arguments, status: 'completed' };
      this.event('response.output_item.done', { output_index: outputIndex, item: done });
      output.push(done);
      outputIndex += 1;
    }

    this.event('response.completed', {
      response: {
        id: this.responseId,
        object: 'response',
        created_at: completion.created,
        status: 'completed',
        error: null,
        incomplete_details: null,
        model: completion.model || this.model,
        output,
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

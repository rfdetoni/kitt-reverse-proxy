import type { Response } from 'express';
import type { JsonObject, OpenAiCompletion } from '../types.js';
import { isJsonObject, toJsonValue } from '../util/json.js';

export function validateOllamaChatBody(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new Error('Body deve ser objeto JSON.');
  if (!Array.isArray(value.messages) || value.messages.length === 0) {
    throw new Error('"messages" deve ser array não vazio.');
  }
  return value;
}

export function ollamaGenerateBodyToChat(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new Error('Body deve ser objeto JSON.');
  const prompt = typeof value.prompt === 'string' ? value.prompt : '';
  if (!prompt.trim()) throw new Error('"prompt" deve ser uma string não vazia.');

  const messages: JsonObject[] = [];
  if (typeof value.system === 'string' && value.system.trim()) {
    messages.push({ role: 'system', content: value.system });
  }
  messages.push({ role: 'user', content: prompt });

  return {
    messages,
    ...(value.model !== undefined ? { model: value.model } : {}),
    ...(value.stream !== undefined ? { stream: value.stream } : {})
  };
}

export function completionToOllamaChat(completion: OpenAiCompletion, modelId: string): JsonObject {
  const content = completion.choices[0]?.message.content || '';
  return toJsonValue({
    model: completion.model || modelId,
    created_at: new Date().toISOString(),
    message: {
      role: 'assistant',
      content
    },
    done: true,
    done_reason: 'stop',
    total_duration: 0,
    load_duration: 0,
    prompt_eval_count: 0,
    eval_count: 0
  }) as JsonObject;
}

export function completionToOllamaGenerate(completion: OpenAiCompletion, modelId: string): JsonObject {
  const response = completion.choices[0]?.message.content || '';
  return toJsonValue({
    model: completion.model || modelId,
    created_at: new Date().toISOString(),
    response,
    done: true,
    done_reason: 'stop',
    context: [],
    total_duration: 0
  }) as JsonObject;
}

export function ollamaTagsResponse(modelId: string): JsonObject {
  const now = new Date().toISOString();
  return {
    models: [
      {
        name: modelId,
        model: modelId,
        modified_at: now,
        size: 0,
        digest: 'kitt-reverse-proxy',
        details: {
          parent_model: '',
          format: 'web',
          family: 'browser',
          families: ['browser'],
          parameter_size: 'web',
          quantization_level: 'none'
        }
      }
    ]
  };
}

function prepareNdjson(res: Response): void {
  res.status(200);
  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('x-accel-buffering', 'no');
  res.flushHeaders?.();
}

export class OllamaChatStreamWriter {
  private started = false;

  constructor(private readonly res: Response, private readonly model: string) {}

  begin(): void {
    if (this.started) return;
    this.started = true;
    prepareNdjson(this.res);
  }

  delta(text: string): void {
    if (!text) return;
    this.begin();
    this.res.write(
      JSON.stringify({
        model: this.model,
        created_at: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: text
        },
        done: false
      }) + '\n'
    );
  }

  finish(): void {
    this.begin();
    this.res.write(
      JSON.stringify({
        model: this.model,
        created_at: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: ''
        },
        done: true,
        done_reason: 'stop'
      }) + '\n'
    );
    this.res.end();
  }
}

export class OllamaGenerateStreamWriter {
  private started = false;

  constructor(private readonly res: Response, private readonly model: string) {}

  begin(): void {
    if (this.started) return;
    this.started = true;
    prepareNdjson(this.res);
  }

  delta(text: string): void {
    if (!text) return;
    this.begin();
    this.res.write(
      JSON.stringify({
        model: this.model,
        created_at: new Date().toISOString(),
        response: text,
        done: false
      }) + '\n'
    );
  }

  finish(): void {
    this.begin();
    this.res.write(
      JSON.stringify({
        model: this.model,
        created_at: new Date().toISOString(),
        response: '',
        done: true,
        done_reason: 'stop',
        context: []
      }) + '\n'
    );
    this.res.end();
  }
}

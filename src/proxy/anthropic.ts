import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { JsonObject, JsonValue, OpenAiCompletion } from '../types.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function textFromBlocks(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((block) => {
      const item = record(block);
      return item?.type === 'text' && typeof item.text === 'string' ? item.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function toolsToOpenAi(value: unknown): JsonValue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((tool) => {
    const item = record(tool);
    if (!item || typeof item.name !== 'string') {
      throw new Error('Anthropic tool inválida: name é obrigatório.');
    }
    return {
      type: 'function',
      function: {
        name: item.name,
        ...(typeof item.description === 'string' ? { description: item.description } : {}),
        ...(item.input_schema !== undefined ? { parameters: item.input_schema as JsonValue } : {})
      }
    } as JsonValue;
  });
}

function toolChoiceToOpenAi(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  const item = record(value);
  if (!item || typeof item.type !== 'string') throw new Error('Anthropic tool_choice inválido.');
  switch (item.type) {
    case 'auto': return 'auto';
    case 'none': return 'none';
    case 'any': return 'required';
    case 'tool':
      if (typeof item.name !== 'string' || !item.name.trim()) {
        throw new Error('Anthropic tool_choice.tool exige name.');
      }
      return { type: 'function', function: { name: item.name } };
    default:
      throw new Error(`Anthropic tool_choice não suportado: ${item.type}`);
  }
}

function anthropicMessageToOpenAi(message: unknown): JsonValue[] {
  const item = record(message);
  if (!item || typeof item.role !== 'string') throw new Error('Anthropic message inválida.');
  const role = item.role;

  if (typeof item.content === 'string') {
    return [{ role, content: item.content }];
  }
  if (!Array.isArray(item.content)) {
    return [{ role, content: '' }];
  }

  const output: JsonValue[] = [];
  const text = textFromBlocks(item.content);
  if (text) output.push({ role, content: text });

  for (const block of item.content) {
    const content = record(block);
    if (!content || typeof content.type !== 'string') continue;

    if (content.type === 'tool_use') {
      if (role !== 'assistant') throw new Error('tool_use só é válido em assistant.');
      if (typeof content.id !== 'string' || typeof content.name !== 'string') {
        throw new Error('tool_use exige id e name.');
      }
      output.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: content.id,
          type: 'function',
          function: {
            name: content.name,
            arguments: JSON.stringify(content.input ?? {})
          }
        }]
      });
    }

    if (content.type === 'tool_result') {
      if (role !== 'user') throw new Error('tool_result só é válido em user.');
      if (typeof content.tool_use_id !== 'string') throw new Error('tool_result exige tool_use_id.');
      const resultText = typeof content.content === 'string'
        ? content.content
        : textFromBlocks(content.content) || JSON.stringify(content.content ?? '');
      output.push({
        role: 'tool',
        tool_call_id: content.tool_use_id,
        content: resultText
      });
    }
  }

  return output.length ? output : [{ role, content: '' }];
}

export function anthropicBodyToChat(value: unknown): JsonObject {
  const body = record(value);
  if (!body) throw new Error('Body Anthropic inválido.');
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new Error('Anthropic messages deve ser array não vazio.');
  }

  const messages: JsonValue[] = [];
  const system = textFromBlocks(body.system);
  if (system) messages.push({ role: 'system', content: system });
  for (const message of body.messages) {
    messages.push(...anthropicMessageToOpenAi(message));
  }

  const tools = toolsToOpenAi(body.tools);
  const toolChoice = toolChoiceToOpenAi(body.tool_choice);

  return {
    model: typeof body.model === 'string' ? body.model : '',
    messages,
    ...(typeof body.max_tokens === 'number' ? { max_tokens: body.max_tokens } : {}),
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === 'number' ? { top_p: body.top_p } : {}),
    ...(body.stream === true ? { stream: true } : {}),
    ...(tools?.length ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {})
  };
}

export function completionToAnthropic(completion: OpenAiCompletion): JsonObject {
  const message = completion.choices[0]?.message;
  const content: JsonValue[] = [];
  if (message?.content) content.push({ type: 'text', text: message.content });
  for (const call of message?.tool_calls || []) {
    let input: JsonValue = {};
    try {
      input = JSON.parse(call.function.arguments) as JsonValue;
    } catch {
      input = {};
    }
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input
    });
  }

  const hasTools = Boolean(message?.tool_calls?.length);
  const usage = completion.usage || {};
  return {
    id: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    model: completion.model,
    content,
    stop_reason: hasTools ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.prompt_tokens || 0),
      output_tokens: Number(usage.completion_tokens || 0)
    }
  };
}

export function sendAnthropicError(
  res: Response,
  status: number,
  message: string,
  type = 'api_error'
): void {
  res.status(status).json({
    type: 'error',
    error: { type, message }
  });
}

export class AnthropicStreamWriter {
  private started = false;
  private index = 0;
  private readonly messageId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

  constructor(private readonly res: Response, private readonly model: string) {}

  private event(name: string, data: JsonObject): void {
    this.res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private begin(): void {
    if (this.started) return;
    this.started = true;
    this.res.status(200);
    this.res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    this.res.setHeader('cache-control', 'no-cache, no-transform');
    this.res.setHeader('connection', 'keep-alive');
    this.res.flushHeaders?.();
    this.event('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });
  }

  delta(text: string): void {
    if (!text) return;
    this.begin();
    if (this.index === 0) {
      this.event('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
      });
    }
    this.event('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text }
    });
  }

  finish(completion: OpenAiCompletion, fallbackDeltas: string[] = []): void {
    this.begin();
    const message = completion.choices[0]?.message;
    const text = message?.content || '';
    const toolCalls = message?.tool_calls || [];
    let contentIndex = 0;

    if (text) {
      if (fallbackDeltas.length) {
        for (const delta of fallbackDeltas) this.delta(delta);
      } else {
        this.delta(text);
      }
      this.event('content_block_stop', {
        type: 'content_block_stop',
        index: contentIndex
      });
      contentIndex += 1;
    }

    for (const call of toolCalls) {
      this.event('content_block_start', {
        type: 'content_block_start',
        index: contentIndex,
        content_block: {
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input: {}
        }
      });
      this.event('content_block_delta', {
        type: 'content_block_delta',
        index: contentIndex,
        delta: {
          type: 'input_json_delta',
          partial_json: call.function.arguments
        }
      });
      this.event('content_block_stop', {
        type: 'content_block_stop',
        index: contentIndex
      });
      contentIndex += 1;
    }

    const usage = completion.usage || {};
    this.event('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: toolCalls.length ? 'tool_use' : 'end_turn',
        stop_sequence: null
      },
      usage: {
        output_tokens: Number(usage.completion_tokens || 0)
      }
    });
    this.event('message_stop', { type: 'message_stop' });
    this.res.end();
  }
}

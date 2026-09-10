import { InvalidRequestError } from '../core/errors.js';
import { isJsonObject } from '../util/json.js';
import type { JsonObject, JsonValue } from '../types.js';

const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_MESSAGES = 4_096;
const MAX_TOOLS = 256;

function fail(message: string): never {
  throw new InvalidRequestError(message);
}

function optionalNumber(body: JsonObject, key: string, min: number, max: number): void {
  const value = body[key];
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(`"${key}" deve ser número entre ${min} e ${max}.`);
  }
}

function optionalPositiveInteger(body: JsonObject, key: string): void {
  const value = body[key];
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail(`"${key}" deve ser inteiro positivo.`);
  }
}

function validateMessages(messages: JsonValue[]): void {
  if (messages.length === 0 || messages.length > MAX_MESSAGES) {
    fail(`"messages" deve conter entre 1 e ${MAX_MESSAGES} itens.`);
  }
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!isJsonObject(message)) fail(`messages[${index}] deve ser objeto.`);
    if (typeof message.role !== 'string' || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) {
      fail(`messages[${index}].role inválido.`);
    }
    if (!('content' in message) && !Array.isArray(message.tool_calls)) {
      fail(`messages[${index}] deve conter content ou tool_calls.`);
    }
    if (message.tool_call_id !== undefined && typeof message.tool_call_id !== 'string') {
      fail(`messages[${index}].tool_call_id deve ser string.`);
    }
  }
}

function validateTools(value: JsonValue | undefined): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > MAX_TOOLS) fail(`"tools" deve ser array com no máximo ${MAX_TOOLS} itens.`);
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const tool = value[index];
    if (!isJsonObject(tool) || tool.type !== 'function' || !isJsonObject(tool.function)) {
      fail(`tools[${index}] deve ser function tool.`);
    }
    const name = tool.function.name;
    if (typeof name !== 'string' || !TOOL_NAME.test(name)) fail(`tools[${index}].function.name inválido.`);
    if (seen.has(name)) fail(`Function duplicada em tools: ${name}.`);
    seen.add(name);
    if (tool.function.parameters !== undefined && !isJsonObject(tool.function.parameters)) {
      fail(`tools[${index}].function.parameters deve ser objeto JSON Schema.`);
    }
  }
}

export function validateOpenAiChatRequest(value: unknown): JsonObject {
  if (!isJsonObject(value)) fail('Body deve ser objeto JSON.');
  const body = value as JsonObject;
  if (!Array.isArray(body.messages)) fail('"messages" deve ser array.');
  validateMessages(body.messages);

  if (body.model !== undefined && (typeof body.model !== 'string' || !body.model.trim() || body.model.length > 256)) {
    fail('"model" deve ser string não vazia de até 256 caracteres.');
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') fail('"stream" deve ser boolean.');
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') {
    fail('"parallel_tool_calls" deve ser boolean.');
  }
  optionalNumber(body, 'temperature', 0, 2);
  optionalNumber(body, 'top_p', 0, 1);
  optionalPositiveInteger(body, 'max_tokens');
  optionalPositiveInteger(body, 'max_completion_tokens');
  validateTools(body.tools);

  if (body.response_format !== undefined && !isJsonObject(body.response_format)) {
    fail('"response_format" deve ser objeto.');
  }
  return body;
}

export function validateResponsesRequest(value: unknown): JsonObject {
  if (!isJsonObject(value)) fail('Body deve ser objeto JSON.');
  const body = value as JsonObject;
  if (typeof body.input !== 'string' && !Array.isArray(body.input)) fail('"input" deve ser string ou array.');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') fail('"stream" deve ser boolean.');
  if (body.model !== undefined && (typeof body.model !== 'string' || !body.model.trim() || body.model.length > 256)) {
    fail('"model" deve ser string não vazia de até 256 caracteres.');
  }
  validateTools(body.tools);
  optionalNumber(body, 'temperature', 0, 2);
  optionalNumber(body, 'top_p', 0, 1);
  optionalPositiveInteger(body, 'max_output_tokens');
  return body;
}

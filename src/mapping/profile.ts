import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AdapterProfile, BindingSource, BindingTransform, JsonValue, JoinStrategy, RequestBinding, StateUpdate } from '../types.js';
import { parseJsonPath } from '../util/path.js';

const SOURCES = new Set<BindingSource>([
  'openai.messages', 'openai.last_user_text', 'openai.last_message_text', 'openai.transcript',
  'openai.system_text', 'openai.model', 'openai.temperature', 'openai.top_p', 'openai.max_tokens',
  'openai.stream', 'openai.tools_json', 'openai.tool_choice_json', 'generated.uuid',
  'generated.request_id', 'generated.timestamp_ms', 'generated.timestamp_s'
]);
const JOIN_STRATEGIES = new Set(['smart', 'concat', 'first', 'last']);
const MAX_PROFILE_BYTES = 64 * 1024;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} deve ser objeto.`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} deve ser string não vazia.`);
  return value.trim();
}

function validateTransform(value: unknown, label: string): BindingTransform | undefined {
  if (value === undefined) return undefined;
  const input = object(value, label);
  const type = string(input.type, `${label}.type`);
  if (type === 'identity' || type === 'string') return { type };
  if (type !== 'message_array') throw new Error(`${label}.type inválido: ${type}`);
  const rolePath = string(input.rolePath, `${label}.rolePath`);
  const contentPath = string(input.contentPath, `${label}.contentPath`);
  parseJsonPath(rolePath);
  parseJsonPath(contentPath);
  if (rolePath.includes('[*]') || contentPath.includes('[*]')) throw new Error(`${label} não aceita wildcard em rolePath/contentPath.`);
  const result: BindingTransform = {
    type: 'message_array', rolePath, contentPath,
    ...(typeof input.includeSystem === 'boolean' ? { includeSystem: input.includeSystem } : {})
  };
  if (input.roleMap !== undefined) {
    const roleMapInput = object(input.roleMap, `${label}.roleMap`);
    const roleMap: Record<string, string> = {};
    for (const [key, roleValue] of Object.entries(roleMapInput)) {
      if (!['system', 'user', 'assistant', 'tool'].includes(key)) throw new Error(`${label}.roleMap contém role inválido: ${key}`);
      roleMap[key] = string(roleValue, `${label}.roleMap.${key}`);
    }
    result.roleMap = roleMap;
  }
  return result;
}

function validateBinding(value: unknown, index: number): RequestBinding {
  const input = object(value, `request.bindings[${index}]`);
  const target = string(input.target, `request.bindings[${index}].target`);
  parseJsonPath(target);
  const source = string(input.source, `request.bindings[${index}].source`) as BindingSource;
  if (!SOURCES.has(source)) throw new Error(`Binding source não suportado: ${source}`);
  const transform = validateTransform(input.transform, `request.bindings[${index}].transform`);
  return {
    target,
    source,
    ...(typeof input.optional === 'boolean' ? { optional: input.optional } : {}),
    ...(transform ? { transform } : {})
  };
}

function validateStateUpdate(value: unknown, index: number): StateUpdate {
  const input = object(value, `state.updates[${index}]`);
  const responsePath = string(input.responsePath, `state.updates[${index}].responsePath`);
  const requestTarget = string(input.requestTarget, `state.updates[${index}].requestTarget`);
  parseJsonPath(responsePath);
  parseJsonPath(requestTarget);
  return {
    responsePath,
    requestTarget,
    ...(typeof input.optional === 'boolean' ? { optional: input.optional } : {})
  };
}

export function validateProfile(value: unknown): AdapterProfile {
  const input = object(value, 'profile');
  if (input.version !== 2) throw new Error('profile.version deve ser 2.');
  const request = object(input.request, 'profile.request');
  if (!Array.isArray(request.bindings) || request.bindings.length === 0 || request.bindings.length > 64) {
    throw new Error('profile.request.bindings deve ter entre 1 e 64 itens.');
  }
  const bindings = request.bindings.map(validateBinding);
  const conversational = bindings.some((binding) => [
    'openai.messages', 'openai.last_user_text', 'openai.last_message_text', 'openai.transcript'
  ].includes(binding.source));
  if (!conversational) throw new Error('Profile precisa mapear o conteúdo da conversa do request OpenAI.');

  let removePaths: string[] | undefined;
  if (request.removePaths !== undefined) {
    if (!Array.isArray(request.removePaths) || request.removePaths.length > 64) throw new Error('request.removePaths inválido.');
    removePaths = request.removePaths.map((path, index) => {
      const result = string(path, `request.removePaths[${index}]`);
      parseJsonPath(result);
      return result;
    });
  }

  const response = object(input.response, 'profile.response');
  if (!Array.isArray(response.contentPaths) || response.contentPaths.length > 32) throw new Error('response.contentPaths inválido.');
  const contentPaths = response.contentPaths.map((path, index) => {
    const result = string(path, `response.contentPaths[${index}]`);
    parseJsonPath(result);
    return result;
  });
  const joinStrategy = response.joinStrategy === undefined ? undefined : string(response.joinStrategy, 'response.joinStrategy');
  if (joinStrategy && !JOIN_STRATEGIES.has(joinStrategy)) throw new Error(`joinStrategy inválido: ${joinStrategy}`);
  const separator = response.separator === undefined ? undefined : String(response.separator);
  const finishReasonPath = response.finishReasonPath === undefined ? undefined : string(response.finishReasonPath, 'response.finishReasonPath');
  const idPath = response.idPath === undefined ? undefined : string(response.idPath, 'response.idPath');
  if (finishReasonPath) parseJsonPath(finishReasonPath);
  if (idPath) parseJsonPath(idPath);

  let state: AdapterProfile['state'];
  if (input.state !== undefined) {
    const stateInput = object(input.state, 'profile.state');
    if (stateInput.updates !== undefined) {
      if (!Array.isArray(stateInput.updates) || stateInput.updates.length > 32) throw new Error('state.updates inválido.');
      state = { updates: stateInput.updates.map(validateStateUpdate) };
    } else {
      state = {};
    }
  }

  let metadata: AdapterProfile['metadata'];
  if (input.metadata !== undefined) {
    const metadataInput = object(input.metadata, 'profile.metadata');
    metadata = {
      ...(typeof metadataInput.targetHost === 'string' ? { targetHost: metadataInput.targetHost } : {}),
      ...(typeof metadataInput.endpointPath === 'string' ? { endpointPath: metadataInput.endpointPath } : {}),
      ...(typeof metadataInput.generatedBy === 'string' ? { generatedBy: metadataInput.generatedBy } : {})
    };
  }

  const requestResult: AdapterProfile['request'] = { bindings };
  if (removePaths) requestResult.removePaths = removePaths;
  const responseResult: AdapterProfile['response'] = { contentPaths };
  if (joinStrategy) responseResult.joinStrategy = joinStrategy as JoinStrategy;
  if (separator !== undefined) responseResult.separator = separator;
  if (finishReasonPath) responseResult.finishReasonPath = finishReasonPath;
  if (idPath) responseResult.idPath = idPath;
  const result: AdapterProfile = { version: 2, request: requestResult, response: responseResult };
  if (state) result.state = state;
  if (metadata) result.metadata = metadata;
  return Object.freeze(result);
}

export function parseProfileText(text: string): AdapterProfile {
  if (Buffer.byteLength(text, 'utf8') > MAX_PROFILE_BYTES) throw new Error(`Profile excede ${MAX_PROFILE_BYTES} bytes.`);
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return validateProfile(JSON.parse(trimmed) as JsonValue);
  } catch (firstError) {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) throw firstError;
    return validateProfile(JSON.parse(trimmed.slice(start, end + 1)) as JsonValue);
  }
}

export async function loadProfile(path: string): Promise<AdapterProfile> {
  return parseProfileText(await readFile(path, 'utf8'));
}

export async function saveProfile(path: string, profile: AdapterProfile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(profile, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

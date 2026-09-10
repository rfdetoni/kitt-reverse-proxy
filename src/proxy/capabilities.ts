import { PROVIDERS } from '../providers/catalog.js';
import type { AppConfig, JsonObject, JsonValue } from '../types.js';
import type { SessionManager } from '../runtime/session-manager.js';

const SERVICE_VERSION = '3.0.0';

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

function boolean(value: JsonValue | undefined, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function sessionManagementContract(manager: SessionManager): JsonObject {
  return {
    version: 1,
    header: 'X-Kitt-Session-Id',
    list_endpoint: '/v1/kitt/sessions',
    reset_endpoint: '/v1/kitt/reset',
    delete_endpoint_template: '/v1/kitt/sessions/:id',
    ...manager.capacity()
  };
}

function reasoningContract(manager: SessionManager): JsonObject {
  const description = manager.describe();
  const reasoning = asObject(description.reasoning);
  if (!reasoning || reasoning.supported !== true) return { supported: false };
  return {
    supported: true,
    dynamic: boolean(reasoning.dynamic, true),
    header: 'X-Kitt-Reasoning-Effort',
    range: Array.isArray(reasoning.range) ? reasoning.range : [0, 100],
    ...(Array.isArray(reasoning.levels) ? { levels: reasoning.levels } : {})
  };
}

export function kittAgentCliCapabilities(manager: SessionManager): JsonObject {
  const sessions = sessionManagementContract(manager);
  const reasoning = reasoningContract(manager);
  return {
    protocol: 'openai-chat-completions',
    native_tool_roundtrip: true,
    session_header: 'X-Kitt-Session-Id',
    request_id_header: 'X-Kitt-Request-Id',
    reasoning_header: reasoning.supported === true ? 'X-Kitt-Reasoning-Effort' : null,
    reasoning_range: reasoning.supported === true ? reasoning.range ?? [0, 100] : [0, 100],
    reasoning_supported: reasoning.supported === true,
    reasoning_dynamic: reasoning.dynamic === true,
    reasoning,
    session_management: sessions,
    parallel_tool_calls_recommended: false
  };
}

export function runtimeCapabilities(manager: SessionManager, config: AppConfig): JsonObject {
  const provider = PROVIDERS.find((item) => item.id === manager.providerId);
  const description = manager.describe();
  const imageInput = manager.transport === 'ui' && Boolean(provider?.ui.supportsImageUpload);
  const reasoning = reasoningContract(manager);
  const toolCalling = typeof description.toolCalling === 'string' ? description.toolCalling : 'protocol-emulated';

  return {
    status: 'ok',
    service: 'kitt-reverse-proxy',
    version: SERVICE_VERSION,
    provider: manager.providerId,
    transport: manager.transport,
    model: manager.modelId,
    structured_output: 'best_effort',
    structured_output_retry: true,
    tool_enforcement: config.toolEnforcement ?? 'explore-first',
    kitt_agent_cli: kittAgentCliCapabilities(manager),
    image_input: {
      supported: imageInput,
      provider: manager.providerId
    },
    reasoning,
    protocols: {
      openai: {
        chat_completions: true,
        responses: true,
        streaming: true,
        tools: true,
        legacy_functions: true,
        parallel_tool_calls: true,
        function_call_output: true,
        function_tools_only: true,
        previous_response_id: false,
        structured_outputs: true
      },
      anthropic: {
        messages: true,
        streaming: true,
        tools: true,
        tool_result: true
      },
      ollama: {
        chat: true,
        streaming: true,
        tools: true
      }
    },
    semantics: {
      tool_execution: 'client',
      tool_calling: toolCalling,
      strict_json_schema_enforcement: false,
      conversation_scope: manager.capacity().accepts_named_sessions ? 'multi_session' : 'single_session',
      cancellation: 'cooperative'
    }
  };
}

export function modelRecord(manager: SessionManager): JsonObject {
  const description = manager.describe();
  const capabilities = runtimeCapabilities(manager, { toolEnforcement: 'auto' } as AppConfig);
  const openai = asObject(asObject(capabilities.protocols)?.openai);
  const model: JsonObject = {
    id: manager.modelId,
    object: 'model',
    owned_by: 'kitt-reverse-proxy',
    root: manager.modelId,
    parent: null,
    capabilities: {
      completion: true,
      chat_completion: true,
      tools: boolean(openai?.tools, true),
      tool_calls: boolean(openai?.tools, true),
      streaming: boolean(openai?.streaming, true)
    }
  };
  if (typeof description.contextWindow === 'number') model.context_window = description.contextWindow;
  if (typeof description.maxOutputTokens === 'number') model.max_output_tokens = description.maxOutputTokens;
  return model;
}

export function serviceVersion(): string {
  return SERVICE_VERSION;
}

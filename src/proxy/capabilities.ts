import { PROVIDERS, type ProviderPreset } from '../providers/catalog.js';
import type { AppConfig, JsonObject, JsonValue } from '../types.js';
import type { SessionManager } from '../runtime/session-manager.js';
import { AGENT_CONTRACT_HEADER, AGENT_CONTRACT_VERSION, AGENT_ROUTE_HEADER, AGENT_ROUTES } from '../runtime/agent-contract.js';
import { SERVICE_NAME, SERVICE_VERSION } from '../version.js';
import { BROWSER_AUTOMATION_ACTIONS } from '../runtime/browser-automation.js';
import { tracingContract } from '../observability/tracing.js';
import { semanticLocatorContract } from '../runtime/semantic-locator.js';
import { currentLogContentPolicy } from '../logger.js';

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
    introspection_endpoint: '/v1/kitt/session',
    reset_endpoint: '/v1/kitt/reset',
    delete_endpoint_template: '/v1/kitt/sessions/:id',
    ...manager.capacity()
  };
}

function browserAutomationContract(manager: SessionManager): JsonObject {
  return {
    supported: manager.browserAutomationSupported(),
    endpoint_template: '/v1/kitt/browser/:action',
    session_header: 'X-Kitt-Session-Id',
    isolated_tab: true,
    javascript_eval: false,
    origin_scope_enforced: true,
    origin_scope_header: 'X-Kitt-Browser-Origin-Scope',
    origin_scope_encoding: 'base64url-json-array',
    default_origin_scope: 'loopback',
    top_level_navigation_enforced: true,
    popups_blocked: true,
    actions: [...BROWSER_AUTOMATION_ACTIONS],
    screenshot_formats: ['jpeg', 'png']
  };
}

function reasoningContract(): JsonObject {
  // Reasoning is configured by the user in the authenticated WebChat UI.
  // The reverse proxy intentionally exposes no API-side reasoning control.
  return { supported: false };
}

export function providerRecord(provider: ProviderPreset, manager?: SessionManager): JsonObject {
  const active = manager?.providerId === provider.id;
  const description = active ? manager.describe() : undefined;
  const resilience = description ? asObject(description.resilience) : undefined;
  return {
    id: provider.id,
    object: 'provider',
    name: provider.name,
    active,
    preferred_transport: provider.preferredTransport,
    transports: [...provider.transports],
    auth: provider.auth,
    hosts: [...provider.hosts],
    models: provider.models.map((item) => ({ id: item.id, aliases: [...item.aliases] })),
    capabilities: {
      streaming: provider.capabilities.streaming,
      tools: provider.capabilities.tools,
      structured_output: provider.capabilities.structuredOutput,
      system_messages: provider.capabilities.systemMessages,
      reasoning: provider.capabilities.reasoning,
      image_input: provider.ui.supportsImageUpload
    },
    ui: {
      selector_version: provider.ui.selectorVersion,
      semantic_locator: semanticLocatorContract()
    },
    health: active ? (resilience ?? { circuit: 'closed' }) : { circuit: 'unknown' }
  };
}

export function kittAgentCliCapabilities(manager: SessionManager): JsonObject {
  const sessions = sessionManagementContract(manager);
  return {
    proxy_contract_version: 2,
    protocol: 'openai-chat-completions',
    native_tool_roundtrip: true,
    agent_contract: {
      version: AGENT_CONTRACT_VERSION,
      header: AGENT_CONTRACT_HEADER,
      route_header: AGENT_ROUTE_HEADER,
      routes: [...AGENT_ROUTES]
    },
    session_header: 'X-Kitt-Session-Id',
    request_id_header: 'X-Kitt-Request-Id',
    reasoning_header: null,
    reasoning_supported: false,
    reasoning: reasoningContract(),
    session_management: sessions,
    browser_automation: browserAutomationContract(manager),
    parallel_tool_calls_recommended: false
  };
}

export function runtimeCapabilities(manager: SessionManager, config: AppConfig): JsonObject {
  const provider = PROVIDERS.find((item) => item.id === manager.providerId);
  const description = manager.describe();
  const imageInput = manager.transport === 'ui' && Boolean(provider?.ui.supportsImageUpload);
  const toolCalling = typeof description.toolCalling === 'string' ? description.toolCalling : 'protocol-emulated';
  const resilience = asObject(description.resilience);

  return {
    status: 'ok',
    contract_version: 2,
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    provider: manager.providerId,
    transport: manager.transport,
    model: manager.modelId,
    usage: {
      supported: true,
      mode: 'estimated_when_unavailable',
      usage_is_estimated: true
    },
    structured_output: 'best_effort',
    structured_output_retry: true,
    tool_enforcement: config.toolEnforcement ?? 'explore-first',
    kitt_agent_cli: kittAgentCliCapabilities(manager),
    image_input: {
      supported: imageInput,
      provider: manager.providerId
    },
    browser_automation: browserAutomationContract(manager),
    reasoning: reasoningContract(),
    resilience: resilience ?? { circuit: 'closed' },
    provider_discovery: {
      list_endpoint: '/v1/providers',
      detail_endpoint_template: '/v1/providers/:provider',
      models_endpoint_template: '/v1/providers/:provider/models'
    },
    provider_registry: {
      version: 3,
      plugin_api_version: 1,
      modular_manifests: true,
      default_plugins_separate: true,
      external_plugins: true,
      explicit_loading: true,
      selector_pack_versioned: true,
      conformance_required: true
    },
    observability: {
      metrics: {
        prometheus: true,
        json: true,
        endpoint: '/v1/kitt/metrics'
      },
      tracing: tracingContract(),
      logs: {
        structured_json: true,
        request_correlation: true,
        content_policy: currentLogContentPolicy()
      }
    },
    control_planes: {
      data: ['/v1/chat/completions', '/v1/responses', '/v1/messages', '/api/chat'],
      management: ['/v1/kitt/status', '/v1/kitt/sessions', '/v1/kitt/metrics', '/v1/capabilities'],
      browser: ['/v1/kitt/browser/:action'],
      authentication: 'shared-api-key',
      browser_origin_scope_enforced: true
    },
    protocols: {
      openai: {
        chat_completions: true,
        responses: true,
        embeddings: false,
        streaming: true,
        stream_keepalive: true,
        tools: true,
        legacy_functions: true,
        parallel_tool_calls: true,
        function_call_output: true,
        function_tools_only: true,
        previous_response_id: false,
        structured_outputs: true,
        json_mode: true
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
      cancellation: 'cooperative',
      token_usage: 'estimated_when_upstream_unavailable'
    }
  };
}

export function modelRecord(manager: SessionManager): JsonObject {
  const description = manager.describe();
  const provider = PROVIDERS.find((item) => item.id === manager.providerId);
  const capabilities = runtimeCapabilities(manager, { toolEnforcement: 'auto' } as AppConfig);
  const openai = asObject(asObject(capabilities.protocols)?.openai);
  const imageInput = manager.transport === 'ui' && Boolean(provider?.ui.supportsImageUpload);
  const model: JsonObject = {
    id: manager.modelId,
    object: 'model',
    owned_by: SERVICE_NAME,
    root: manager.modelId,
    parent: null,
    provider: manager.providerId,
    transport: manager.transport,
    capabilities: {
      completion: true,
      chat_completion: true,
      tools: boolean(openai?.tools, true),
      tool_calls: boolean(openai?.tools, true),
      streaming: boolean(openai?.streaming, true),
      structured_output: boolean(openai?.structured_outputs, true),
      json_mode: boolean(openai?.json_mode, true),
      image_input: imageInput,
      reasoning: false,
      embeddings: false
    }
  };
  if (typeof description.contextWindow === 'number') model.context_window = description.contextWindow;
  if (typeof description.maxOutputTokens === 'number') model.max_output_tokens = description.maxOutputTokens;
  return model;
}

export function serviceVersion(): string {
  return SERVICE_VERSION;
}

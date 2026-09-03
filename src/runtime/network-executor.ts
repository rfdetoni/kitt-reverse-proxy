import type { DeclarativeAdapter } from '../mapping/engine.js';
import type { AdapterProfile, AppConfig, CapturedExchange, ChatExecutionResult, ChatExecutor, JsonObject, LiveBrowserSession } from '../types.js';
import { messageToText, normalizeMessages } from '../mapping/messages.js';
import { BrowserUpstreamClient } from './upstream.js';
import {
  applyToolCallsToCompletion,
  assertToolChoiceSatisfied,
  buildToolProtocolPlan,
  completionFromToolCalls,
  extractStructuredToolCalls,
  extractToolCalls,
  formatApiDirective,
  requestMayReturnToolCalls
} from '../mapping/tool-calling.js';

export class NetworkChatExecutor implements ChatExecutor {
  readonly transport = 'network' as const;
  readonly modelId: string;
  private readonly upstream: BrowserUpstreamClient;

  constructor(
    capture: CapturedExchange,
    session: LiveBrowserSession,
    private readonly adapter: DeclarativeAdapter,
    private readonly profile: AdapterProfile,
    private readonly profileSource: string,
    private readonly config: AppConfig
  ) {
    this.modelId = config.apiModel || 'adaptive-web-chat';
    this.upstream = new BrowserUpstreamClient(
      session.context,
      capture.endpointUrl,
      capture.headers,
      capture.requestCodec,
      config.upstreamTimeoutMs,
      config.followRedirects
    );
    this.capture = capture;
  }

  private readonly capture: CapturedExchange;

  async execute(body: JsonObject): Promise<ChatExecutionResult> {
    const messages = normalizeMessages(Array.isArray(body.messages) ? body.messages : undefined);
    const systemPrompt = messages
      .filter((message) => message.role === 'system' || message.role === 'developer')
      .map(messageToText)
      .filter(Boolean)
      .join('\n\n');
    const plan = buildToolProtocolPlan(body, systemPrompt || undefined);

    const supportsNativeTools = body.tools !== undefined && this.profile.request.bindings.some(
      (binding) => binding.source === 'openai.tools_json'
    );
    const supportsNativeChoice = (body.tool_choice === undefined || body.tool_choice === 'auto')
      || this.profile.request.bindings.some((binding) => binding.source === 'openai.tool_choice_json');
    const supportsNativeSystem = this.profile.request.bindings.some((binding) => (
      binding.source === 'openai.system_text'
      || binding.source === 'openai.messages'
      || binding.source === 'openai.transcript'
    ));
    const emulateTools = requestMayReturnToolCalls(body) && (
      !supportsNativeTools
      || !supportsNativeChoice
      || body.parallel_tool_calls === false
      || body.functions !== undefined
    );
    const emulateSystem = Boolean(systemPrompt) && !supportsNativeSystem;
    const needsPolicyEmulation = emulateTools || emulateSystem;

    let requestBody = body;
    if (needsPolicyEmulation) {
      const messages = Array.isArray(body.messages) ? structuredClone(body.messages) : [];
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
        const record = message as JsonObject;
        if (!['user', 'tool'].includes(String(record.role || ''))) continue;
        const content = typeof record.content === 'string'
          ? record.content
          : JSON.stringify(record.content ?? '');
        const promptPlan = {
          tools: emulateTools ? plan.tools : [],
          choice: emulateTools ? plan.choice : { mode: 'none' as const },
          parallel: plan.parallel,
          ...(emulateSystem && plan.systemPrompt ? { systemPrompt: plan.systemPrompt } : {})
        };
        record.content = `${formatApiDirective(promptPlan)}${content}`;
        break;
      }
      requestBody = { ...body, messages };
    }

    const mapped = this.adapter.mapRequest(requestBody);
    const result = await this.upstream.post(mapped);
    const model = typeof body.model === 'string' && body.model.trim() ? body.model : this.modelId;
    const structuredCalls = extractStructuredToolCalls(result.body, plan);

    let completion: ChatExecutionResult['completion'];
    try {
      completion = this.adapter.mapResponse(result.body, model);
    } catch (error) {
      if (!structuredCalls.length) throw error;
      completion = completionFromToolCalls(model, structuredCalls);
    }

    const textual = completion.choices[0]?.message.content || '';
    const parsed = structuredCalls.length
      ? { content: null, tool_calls: structuredCalls }
      : extractToolCalls(textual, plan);

    assertToolChoiceSatisfied(plan, parsed.tool_calls);
    if (parsed.tool_calls?.length) {
      applyToolCallsToCompletion(completion, parsed.tool_calls, parsed.content);
    }

    const deltas = parsed.tool_calls?.length ? [] : this.adapter.mapResponseDeltas(result.body);
    this.adapter.applyState(result.body);
    return { completion, deltas };
  }

  describe(): JsonObject {
    return {
      transport: 'network',
      targetOrigin: new URL(this.capture.endpointUrl).origin,
      profileSource: this.profileSource,
      stateful: Boolean(this.profile.state?.updates?.length),
      requestCodec: this.capture.requestCodec.kind,
      followRedirects: this.config.followRedirects,
      toolCalling: 'native-or-protocol-emulated',
      toolExecution: 'client-side'
    };
  }
}

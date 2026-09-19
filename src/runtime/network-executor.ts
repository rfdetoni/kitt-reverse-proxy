import type { DeclarativeAdapter } from '../mapping/engine.js';
import type { AdapterProfile, AppConfig, CapturedExchange, ChatExecutionOptions, ChatExecutionResult, ChatExecutor, JsonObject, JsonValue, LiveBrowserSession } from '../types.js';
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
import { RequestAbortedError } from './serial-queue.js';

export function prependDirectiveToLastInteractiveMessage(
  messages: JsonValue[] | undefined,
  directive: string
): JsonValue[] {
  const source = Array.isArray(messages) ? messages : [];
  const copy = [...source];

  for (let index = source.length - 1; index >= 0; index -= 1) {
    const message = source[index];
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    const record = message as JsonObject;
    if (!['user', 'tool'].includes(String(record.role || ''))) continue;

    const content = typeof record.content === 'string'
      ? record.content
      : JSON.stringify(record.content ?? '');
    copy[index] = { ...record, content: `${directive}${content}` };
    break;
  }

  return copy;
}

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

  async execute(body: JsonObject, options?: ChatExecutionOptions): Promise<ChatExecutionResult> {
    if (options?.signal?.aborted) throw new RequestAbortedError();
    const messages = normalizeMessages(Array.isArray(body.messages) ? body.messages : undefined);
    const systemParts: string[] = [];
    for (const message of messages) {
      if (message.role !== 'system' && message.role !== 'developer') continue;
      const text = messageToText(message);
      if (text) systemParts.push(text);
    }
    const systemPrompt = systemParts.join('\n\n');
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
      const promptPlan = {
        tools: emulateTools ? plan.tools : [],
        choice: emulateTools ? plan.choice : { mode: 'none' as const },
        parallel: plan.parallel,
        ...(emulateSystem && plan.systemPrompt ? { systemPrompt: plan.systemPrompt } : {})
      };
      const requestMessages = prependDirectiveToLastInteractiveMessage(
        Array.isArray(body.messages) ? body.messages : undefined,
        formatApiDirective(promptPlan)
      );
      requestBody = { ...body, messages: requestMessages };
    }

    if (options?.signal?.aborted) throw new RequestAbortedError();
    const mapped = this.adapter.mapRequest(requestBody);
    const result = await this.upstream.post(mapped, options?.signal);
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
    if (parsed.tool_calls?.length) applyToolCallsToCompletion(completion, parsed.tool_calls, parsed.content);

    const deltas = parsed.tool_calls?.length ? [] : this.adapter.mapResponseDeltas(result.body);
    if (options?.onDelta) {
      for (const delta of deltas) await options.onDelta(delta);
    }
    this.adapter.applyState(result.body);
    return { completion, deltas: options?.onDelta ? [] : deltas };
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
      toolExecution: 'client-side',
      cancellation: 'cooperative'
    };
  }
}

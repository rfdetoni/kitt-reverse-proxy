import type { DeclarativeAdapter } from '../mapping/engine.js';
import type { AdapterProfile, AppConfig, CapturedExchange, ChatExecutionResult, ChatExecutor, JsonObject, LiveBrowserSession } from '../types.js';
import { BrowserUpstreamClient } from './upstream.js';

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
    const mapped = this.adapter.mapRequest(body);
    const result = await this.upstream.post(mapped);
    const model = typeof body.model === 'string' && body.model.trim() ? body.model : this.modelId;
    const completion = this.adapter.mapResponse(result.body, model);
    const deltas = this.adapter.mapResponseDeltas(result.body);
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
      followRedirects: this.config.followRedirects
    };
  }
}

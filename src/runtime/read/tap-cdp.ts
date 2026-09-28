import type { CDPSession } from 'playwright';
import { decodeRequestBody } from '../../discovery/body-codec.js';
import { scoreRequestCandidate } from '../../discovery/scoring.js';
import { assertAllowedEndpoint } from '../../security/url-policy.js';
import type { AppConfig, JsonValue, LiveBrowserSession } from '../../types.js';
import type { ProviderPreset } from '../../providers/catalog.js';
import { TapHealthController } from './tap-health.js';
import { AsyncEventQueue } from './tap-queue.js';
import type {
  TapEvent,
  TapFailureReason,
  TapHealthSnapshot,
  TapProfile,
  TapTurn,
  TapTurnMode
} from './types.js';

interface Candidate {
  requestId: string;
  url: string;
  method: string;
  score: number;
  responseContentType?: string;
  finished: boolean;
  failed: boolean;
}

interface ActiveTurn {
  mode: TapTurnMode;
  profile?: TapProfile | undefined;
  needle: string;
  queue: AsyncEventQueue<TapEvent>;
  candidates: Map<string, Candidate>;
  matchedRequestId?: string;
  bytes: number;
  cancelled: boolean;
  matchTimer?: ReturnType<typeof setTimeout> | undefined;
  firstByteTimer?: ReturnType<typeof setTimeout> | undefined;
  stallTimer?: ReturnType<typeof setTimeout> | undefined;
  selectTimer?: ReturnType<typeof setTimeout> | undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function header(headers: unknown, name: string): string {
  const object = record(headers);
  if (!object) return '';
  const found = Object.entries(object).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found && typeof found[1] === 'string' ? found[1] : '';
}

function mime(contentType: string): string {
  return contentType.split(';', 1)[0]!.trim().toLowerCase();
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function promptNeedle(prompt: string): string {
  const value = normalize(prompt);
  return value.slice(Math.max(0, value.length - 160));
}

function jsonContainsNeedle(value: JsonValue, needle: string, depth = 0): boolean {
  if (depth > 12 || value == null) return false;
  if (typeof value === 'string') return normalize(value).includes(needle);
  if (Array.isArray(value)) return value.some((item) => jsonContainsNeedle(item, needle, depth + 1));
  if (typeof value === 'object') return Object.values(value).some((item) => jsonContainsNeedle(item, needle, depth + 1));
  return false;
}

function contentTypeAllowed(contentType: string): boolean {
  return /event-stream|ndjson|json-seq|json|text\/plain|protobuf/i.test(contentType);
}

function profileMatches(profile: TapProfile, url: string, method: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === profile.endpointOrigin
      && parsed.pathname === profile.endpointPath
      && method.toUpperCase() === profile.method.toUpperCase();
  } catch {
    return false;
  }
}

function disabledTurn(): TapTurn {
  return {
    mode: 'disabled',
    async *events(): AsyncIterable<TapEvent> {},
    cancel(): void {}
  };
}

export class CdpStreamTap {
  private cdp: CDPSession | undefined;
  private current: ActiveTurn | undefined;
  private readonly healthController: TapHealthController;

  constructor(
    private readonly session: LiveBrowserSession,
    private readonly provider: ProviderPreset,
    private readonly config: AppConfig
  ) {
    this.healthController = new TapHealthController(
      config.tapBreakerThreshold ?? 3,
      config.tapBreakerCooldownMs ?? 300_000,
      config.tapVerifyTurns ?? 3
    );
  }

  async initialize(): Promise<void> {
    if ((this.config.readMode ?? 'auto') === 'dom') return;
    if (this.cdp) return;
    try {
      const cdp = await this.session.context.newCDPSession(this.session.page);
      cdp.on('Network.requestWillBeSent', this.onRequest);
      cdp.on('Network.responseReceived', this.onResponse);
      cdp.on('Network.dataReceived', this.onData);
      cdp.on('Network.loadingFinished', this.onFinished);
      cdp.on('Network.loadingFailed', this.onFailed);
      await cdp.send('Network.enable');
      this.cdp = cdp;
      this.healthController.setAttached(true);
    } catch {
      this.healthController.setAttached(false);
      this.healthController.recordFailure('attach_failed');
    }
  }

  async reconnect(): Promise<void> {
    await this.detach();
    await this.initialize();
  }

  async detach(): Promise<void> {
    if (this.current && !this.current.cancelled) this.cancelCurrent();
    const cdp = this.cdp;
    this.cdp = undefined;
    this.healthController.setAttached(false);
    if (!cdp) return;
    cdp.off('Network.requestWillBeSent', this.onRequest);
    cdp.off('Network.responseReceived', this.onResponse);
    cdp.off('Network.dataReceived', this.onData);
    cdp.off('Network.loadingFinished', this.onFinished);
    cdp.off('Network.loadingFailed', this.onFailed);
    await cdp.detach().catch(() => undefined);
  }

  arm(prompt: string): TapTurn {
    this.cancelCurrent();
    const decision = this.healthController.turnMode(this.config.readMode ?? 'auto');
    if (decision.mode === 'disabled' || !this.cdp) return disabledTurn();

    const queue = new AsyncEventQueue<TapEvent>();
    const profile = this.healthController.currentProfile();
    const turn: ActiveTurn = {
      mode: decision.mode,
      ...(profile ? { profile } : {}),
      needle: promptNeedle(prompt),
      queue,
      candidates: new Map(),
      bytes: 0,
      cancelled: false
    };
    turn.matchTimer = setTimeout(
      () => this.fail(turn, 'no_matching_request'),
      this.config.tapMatchTimeoutMs ?? 4_000
    );
    turn.matchTimer.unref?.();
    this.current = turn;

    return {
      mode: turn.mode,
      ...(profile ? { profile } : {}),
      events: () => queue.events(),
      cancel: () => this.cancel(turn)
    };
  }

  health(): TapHealthSnapshot {
    return this.healthController.snapshot();
  }

  recordVerified(profile: TapProfile): void {
    this.healthController.recordVerified(profile);
  }

  recordFailure(reason: TapFailureReason): void {
    this.healthController.recordFailure(reason);
  }

  private readonly onRequest = (raw: unknown): void => {
    const turn = this.current;
    if (!turn || turn.cancelled || turn.matchedRequestId) return;
    const event = record(raw);
    const request = record(event?.request);
    if (!event || !request) return;

    const requestId = typeof event.requestId === 'string' ? event.requestId : '';
    const url = typeof request.url === 'string' ? request.url : '';
    const method = typeof request.method === 'string' ? request.method : '';
    const postData = typeof request.postData === 'string' ? request.postData : '';
    if (!requestId || !url || method.toUpperCase() !== 'POST' || !postData) return;
    if (turn.profile && !profileMatches(turn.profile, url, method)) return;

    try {
      assertAllowedEndpoint(this.config.targetUrl, url, this.config.allowedEndpointHosts);
    } catch {
      return;
    }

    const contentType = header(request.headers, 'content-type');
    const decoded = decodeRequestBody(postData, contentType);
    if (!decoded || !turn.needle || !jsonContainsNeedle(decoded.body, turn.needle)) return;

    const resourceType = typeof event.type === 'string' ? event.type.toLowerCase() : 'fetch';
    const score = scoreRequestCandidate(url, decoded.body, resourceType, this.provider.id) + 50;
    if (score < 70) return;
    turn.candidates.set(requestId, {
      requestId,
      url,
      method,
      score,
      finished: false,
      failed: false
    });
  };

  private readonly onResponse = (raw: unknown): void => {
    const turn = this.current;
    if (!turn || turn.cancelled || turn.matchedRequestId) return;
    const event = record(raw);
    const requestId = typeof event?.requestId === 'string' ? event.requestId : '';
    const candidate = turn.candidates.get(requestId);
    if (!candidate) return;

    const response = record(event?.response);
    const contentType = mime(header(response?.headers, 'content-type') || String(response?.mimeType ?? ''));
    if (!contentTypeAllowed(contentType)) return;
    if (turn.profile && contentType !== mime(turn.profile.contentType)) {
      this.fail(turn, 'profile_mismatch');
      return;
    }
    candidate.responseContentType = contentType;

    if (turn.profile) {
      void this.selectCandidate(turn, candidate);
      return;
    }
    if (turn.selectTimer) return;
    turn.selectTimer = setTimeout(() => {
      turn.selectTimer = undefined;
      const ready = [...turn.candidates.values()]
        .filter((item) => Boolean(item.responseContentType))
        .sort((left, right) => right.score - left.score);
      const best = ready[0];
      if (best) void this.selectCandidate(turn, best);
    }, 75);
    turn.selectTimer.unref?.();
  };

  private readonly onData = (raw: unknown): void => {
    const turn = this.current;
    if (!turn || turn.cancelled || !turn.matchedRequestId) return;
    const event = record(raw);
    if (event?.requestId !== turn.matchedRequestId || typeof event.data !== 'string' || !event.data) return;
    this.emitChunk(turn, Buffer.from(event.data, 'base64'));
  };

  private readonly onFinished = (raw: unknown): void => {
    const turn = this.current;
    if (!turn || turn.cancelled) return;
    const event = record(raw);
    const requestId = typeof event?.requestId === 'string' ? event.requestId : '';
    const candidate = turn.candidates.get(requestId);
    if (candidate) candidate.finished = true;
    if (requestId === turn.matchedRequestId) this.finish(turn);
  };

  private readonly onFailed = (raw: unknown): void => {
    const turn = this.current;
    if (!turn || turn.cancelled) return;
    const event = record(raw);
    const requestId = typeof event?.requestId === 'string' ? event.requestId : '';
    const candidate = turn.candidates.get(requestId);
    if (candidate) candidate.failed = true;
    if (requestId === turn.matchedRequestId) this.fail(turn, 'stream_aborted');
  };

  private async selectCandidate(turn: ActiveTurn, candidate: Candidate): Promise<void> {
    if (this.current !== turn || turn.cancelled || turn.matchedRequestId || !this.cdp || !candidate.responseContentType) return;
    turn.matchedRequestId = candidate.requestId;
    this.clearTimer(turn.matchTimer);
    turn.matchTimer = undefined;
    turn.queue.push({
      type: 'matched',
      requestId: candidate.requestId,
      url: candidate.url,
      method: candidate.method,
      contentType: candidate.responseContentType,
      t: Date.now()
    });

    turn.firstByteTimer = setTimeout(
      () => this.fail(turn, 'first_byte_timeout'),
      this.config.tapFirstByteMs ?? 8_000
    );
    turn.firstByteTimer.unref?.();

    try {
      const response = record(await this.cdp.send('Network.streamResourceContent', {
        requestId: candidate.requestId
      }));
      const buffered = typeof response?.bufferedData === 'string' ? response.bufferedData : '';
      if (buffered) this.emitChunk(turn, Buffer.from(buffered, 'base64'));
      if (candidate.failed) this.fail(turn, 'stream_aborted');
      else if (candidate.finished) this.finish(turn);
    } catch {
      this.fail(turn, 'internal_error');
    }
  }

  private emitChunk(turn: ActiveTurn, bytes: Uint8Array): void {
    if (this.current !== turn || turn.cancelled || !bytes.byteLength) return;
    turn.bytes += bytes.byteLength;
    if (turn.bytes > (this.config.tapMaxBytes ?? 8 * 1024 * 1024)) {
      this.fail(turn, 'internal_error');
      return;
    }
    this.clearTimer(turn.firstByteTimer);
    turn.firstByteTimer = undefined;
    this.clearTimer(turn.stallTimer);
    turn.stallTimer = setTimeout(
      () => this.fail(turn, 'stall'),
      this.config.tapStallMs ?? 5_000
    );
    turn.stallTimer.unref?.();
    turn.queue.push({ type: 'chunk', bytes, t: Date.now() });
  }

  private finish(turn: ActiveTurn): void {
    if (this.current !== turn || turn.cancelled) return;
    this.clearTurnTimers(turn);
    turn.queue.push({ type: 'end', ok: true, t: Date.now() });
    turn.queue.close();
    this.current = undefined;
  }

  private fail(turn: ActiveTurn, reason: TapFailureReason): void {
    if (this.current !== turn || turn.cancelled) return;
    this.clearTurnTimers(turn);
    turn.queue.push({ type: 'error', reason });
    turn.queue.close();
    this.current = undefined;
  }

  private cancel(turn: ActiveTurn): void {
    if (turn.cancelled) return;
    turn.cancelled = true;
    this.clearTurnTimers(turn);
    turn.queue.close();
    if (this.current === turn) this.current = undefined;
  }

  private cancelCurrent(): void {
    if (this.current) this.cancel(this.current);
  }

  private clearTurnTimers(turn: ActiveTurn): void {
    this.clearTimer(turn.matchTimer);
    this.clearTimer(turn.firstByteTimer);
    this.clearTimer(turn.stallTimer);
    this.clearTimer(turn.selectTimer);
    turn.matchTimer = undefined;
    turn.firstByteTimer = undefined;
    turn.stallTimer = undefined;
    turn.selectTimer = undefined;
  }

  private clearTimer(timer: ReturnType<typeof setTimeout> | undefined): void {
    if (timer) clearTimeout(timer);
  }
}

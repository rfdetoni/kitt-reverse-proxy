import { randomUUID } from 'node:crypto';
import { ProviderRequestState } from './request-state.js';
import { throwIfAborted } from './cancellation.js';
import type {
  AppConfig,
  ChatExecutionOptions,
  ChatExecutionResult,
  ChatExecutor,
  JsonObject,
  LiveBrowserSession
} from '../types.js';
import { SerialQueue } from './serial-queue.js';
import {
  BrowserAutomationSession,
  BrowserAutomationUnavailableError
} from './browser-automation.js';
import { ResilientChatExecutor, type ProviderCircuitState } from './resilient-executor.js';
import { logger } from '../logger.js';
import { telemetry } from '../util/telemetry.js';
import { updateRequestContext } from '../util/request-context.js';
import { traceSpan } from '../observability/tracing.js';

const SESSION_ID = /^[A-Za-z0-9]{1,64}$/;
const SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;
// Do not discard a conversation between model calls and host tool execution.
const PAGE_PRESSURE_IDLE_GRACE_MS = 5 * 60 * 1000;

function combinedSignal(primary: AbortSignal | undefined, shutdown: AbortSignal): AbortSignal {
  return primary ? AbortSignal.any([primary, shutdown]) : shutdown;
}

async function settleWithin(promises: readonly Promise<unknown>[], timeoutMs: number): Promise<void> {
  if (!promises.length) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.allSettled(promises).then(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class SessionLimitExceededError extends Error {
  constructor() {
    super('Limite de sessões simultâneas atingido.');
    this.name = 'SessionLimitExceededError';
  }
}

export class InvalidSessionIdError extends Error {
  constructor() {
    super('X-Kitt-Session-Id deve conter apenas caracteres alfanuméricos e no máximo 64 caracteres.');
    this.name = 'InvalidSessionIdError';
  }
}

export class SessionNotSupportedError extends Error {
  constructor() {
    super('Sessões nomeadas não são suportadas por este transporte.');
    this.name = 'SessionNotSupportedError';
  }
}

export class SessionBusyError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Sessão ocupada: ${sessionId}.`);
    this.name = 'SessionBusyError';
  }
}

export interface SessionFactoryResult {
  executor: ChatExecutor;
  browserSession?: LiveBrowserSession;
}

export type SessionFactory = (id: string) => Promise<SessionFactoryResult>;

export interface SessionInfo {
  id: string;
  provider: string;
  created_at: string;
  last_activity: string;
  status: 'idle' | 'busy' | 'closing';
  awaiting_tool_result: boolean;
}

export interface SessionCapacitySnapshot {
  provider: string;
  active: number;
  named: number;
  busy: number;
  idle: number;
  pending_creation: number;
  recyclable_idle_named: number;
  awaiting_tool_results: number;
  max: number;
  idle_timeout_ms: number;
  automation_idle_timeout_ms: number;
  automation_pages: number;
  browser_pages: number;
  max_browser_pages: number;
  eviction: 'page_lru_idle';
  accepts_named_sessions: boolean;
  shutting_down: boolean;
}

export interface SessionExecutionLease {
  sessionId: string; contextKey: string; generation: number;
  nativeToolCalling?: boolean;
  execute(body: JsonObject, options?: ChatExecutionOptions): Promise<ChatExecutionResult>;
}

interface ManagedSession {
  generation: number;
  id: string;
  provider: string;
  executor: ChatExecutor;
  browserSession?: LiveBrowserSession;
  browserAutomation?: BrowserAutomationSession;
  browserAutomationLastActivity?: number;
  queue: SerialQueue;
  automationQueue: SerialQueue;
  activeOperations: number;
  reservations: number;
  createdAt: number;
  lastActivity: number;
  status: 'idle' | 'busy' | 'closing';
  isDefault: boolean;
}

function resilient(executor: ChatExecutor, provider: string, states: Map<string, ProviderCircuitState>): ChatExecutor {
  const key = `${provider}:${executor.transport}`;
  const wrapper = executor instanceof ResilientChatExecutor ? executor : new ResilientChatExecutor(executor, provider);
  const shared = states.get(key);
  if (shared) wrapper.shareState(shared); else states.set(key, wrapper.state);
  return wrapper;
}

function awaitsToolResult(session: ManagedSession): boolean {
  return session.executor.hasPendingToolCalls?.() ?? false;
}

export class SessionManager {
  private readonly circuitStates = new Map<string, ProviderCircuitState>();
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly creating = new Map<string, Promise<ManagedSession>>();
  private readonly timer: NodeJS.Timeout;
  private readonly shutdownController = new AbortController();
  private closed = false;
  private generation = 0;
  private readonly instanceId = randomUUID();
  // Named agent's first request can take ownership of the authenticated
  // startup tab. The default route then becomes lazy, never sharing the tab.
  private startupTabAdopted = false;
  private defaultRouteUsed = false;
  private defaultRehydration: Promise<void> | undefined;

  constructor(private readonly options: {
    defaultExecutor: ChatExecutor;
    defaultBrowserSession?: LiveBrowserSession;
    provider: string;
    config: AppConfig;
    factory?: SessionFactory;
    reuseStartupTabForFirstNamed?: boolean;
  }) {
    const now = Date.now();
    this.sessions.set('default', {
      id: 'default',
      generation: ++this.generation,
      provider: options.provider,
      executor: resilient(options.defaultExecutor, options.provider, this.circuitStates),
      ...(options.defaultBrowserSession ? { browserSession: options.defaultBrowserSession } : {}),
      queue: new SerialQueue(options.config.maxQueue, options.config.minIntervalMs),
      automationQueue: new SerialQueue(options.config.maxQueue, 0),
      activeOperations: 0,
      reservations: 0,
      createdAt: now,
      lastActivity: now,
      status: 'idle',
      isDefault: true
    });
    telemetry.setSessionsActive(1);
    const sweepMs = Math.min(60_000, Math.max(5_000, Math.floor(options.config.sessionIdleTimeoutMs / 4)));
    this.timer = setInterval(() => void this.sweepIdle(), sweepMs);
    this.timer.unref();
  }

  get modelId(): string { return this.defaultSession.executor.modelId; }
  get transport(): ChatExecutor['transport'] { return this.defaultSession.executor.transport; }
  get providerId(): string { return this.options.provider; }

  describe(): JsonObject { return this.defaultSession.executor.describe(); }

  browserAutomationSupported(): boolean {
    return Boolean(this.defaultSession.browserSession);
  }

  private get automationIdleTimeoutMs(): number {
    return Math.min(
      120_000,
      Math.max(30_000, Math.floor(this.options.config.sessionIdleTimeoutMs / 4))
    );
  }

  async browserAction(
    requestedId: string | undefined,
    action: string,
    args: JsonObject = {},
    signal?: AbortSignal,
    originScope: readonly string[] = ['loopback']
  ): Promise<JsonObject> {
    const session = await this.resolve(requestedId);
    try {
      if (!session.browserSession) {
        throw new BrowserAutomationUnavailableError(
          'Browser automation requires a UI transport with a live browser session.'
        );
      }
      session.lastActivity = Date.now();
      const signalWithShutdown = combinedSignal(signal, this.shutdownController.signal);
      return await session.automationQueue.run(async () => {
        session.activeOperations += 1;
        session.status = 'busy';
        session.lastActivity = Date.now();
        try {
          throwIfAborted(signalWithShutdown);
          if (action.trim().toLowerCase() === 'close') {
            const current = session.browserAutomation;
            delete session.browserAutomation;
            delete session.browserAutomationLastActivity;
            if (current) await current.close();
            return { action: 'close', closed: Boolean(current), session_id: session.id };
          }
          if (!session.browserAutomation || session.browserAutomation.isClosed()) {
            session.browserAutomation = await BrowserAutomationSession.create(
              session.browserSession!,
              originScope,
              signalWithShutdown
            );
          }
          throwIfAborted(signalWithShutdown);
          session.browserAutomationLastActivity = Date.now();
          const result = await session.browserAutomation.execute(action, args, originScope, signalWithShutdown);
          throwIfAborted(signalWithShutdown);
          session.browserAutomationLastActivity = Date.now();
          return { ...result, session_id: session.id };
        } finally {
          session.lastActivity = Date.now();
          session.activeOperations = Math.max(0, session.activeOperations - 1);
          session.status = session.activeOperations > 0 ? 'busy' : 'idle';
        }
      }, signalWithShutdown);
    } finally { session.reservations -= 1; }
  }

  normalizeSessionId(value: string | undefined): string {
    if (value === undefined || value === '' || value === 'default') return 'default';
    if (!SESSION_ID.test(value)) throw new InvalidSessionIdError();
    return value;
  }

  async execute(requestedId: string | undefined, body: JsonObject, options?: ChatExecutionOptions): Promise<ChatExecutionResult> {
    return this.transaction(requestedId, options ?? {}, (lease) => lease.execute(body, options));
  }
  async transaction<T>(requestedId: string | undefined, options: ChatExecutionOptions, operation: (lease: SessionExecutionLease) => Promise<T>): Promise<T> {
    const ownsLifecycle = !options.lifecycle;
    const lifecycle = options.lifecycle ?? new ProviderRequestState({ ...(options.signal ? { signal: options.signal } : {}) });
    const signal = combinedSignal(lifecycle.signal, this.shutdownController.signal);
    const startedAt = Date.now();
    let session: ManagedSession | undefined;
    try {
      throwIfAborted(signal);
      session = await traceSpan('kitt.session.resolve', { 'kitt.session.requested': requestedId ?? 'default', 'kitt.provider': this.options.provider }, () => this.resolve(requestedId));
      throwIfAborted(signal);
      const resolvedAt = Date.now();
      updateRequestContext({ sessionId: session.id, provider: session.provider });
      session.lastActivity = Date.now();
      const leasedSession = session;
      return await session.queue.run(async () => {
        const session = leasedSession;
        const queueWaitMs = Date.now() - resolvedAt;
        telemetry.recordQueueWait(session.provider, queueWaitMs);
        session.activeOperations += 1; session.status = 'busy';
        const lease: SessionExecutionLease = {
          sessionId: session.id, generation: session.generation, contextKey: `${this.instanceId}:${session.id}:${session.generation}`,
          nativeToolCalling: session.executor.transport === 'network' && session.executor.describe().nativeToolCalling === true,
          execute: async (body, executionOptions = {}) => {
            throwIfAborted(signal);
            const before = lifecycle.attempts; const executorStarted = Date.now();
            // Third-party adapters must also obey the attempt grant before dispatch.
            if (before >= lifecycle.maxAttempts) { lifecycle.beforeSubmit(''); }
            const result = await session.executor.execute(body, { ...options, ...executionOptions, lifecycle, signal });
              if (lifecycle.attempts === before) {
                lifecycle.beforeSubmit(JSON.stringify(body)); lifecycle.received(JSON.stringify(result.completion.choices[0]?.message ?? {}));
              }
              throwIfAborted(signal);
              const timing: JsonObject = { session_resolve_ms: resolvedAt - startedAt, queue_wait_ms: queueWaitMs,
                executor_ms: Date.now() - executorStarted, total_ms: Date.now() - lifecycle.startedAt, transport: session.executor.transport,
                ...(result.metadata?.timing !== undefined ? { executor_timing: result.metadata.timing } : {}) };
              logger.event('info', 'chat.timing', timing);
              return { ...result, completion: { ...result.completion, usage: lifecycle.usage() }, metadata: { ...result.metadata, timing } };
          }
        };
        try { return await operation(lease); }
        catch (error) { session.generation = ++this.generation; throw error; }
        finally { session.lastActivity = Date.now(); session.activeOperations = Math.max(0, session.activeOperations - 1); session.status = session.activeOperations > 0 ? 'busy' : 'idle'; }
      }, signal);
    } catch (error) {
      if (error instanceof Error && ownsLifecycle) Object.assign(error, { usage: lifecycle.usage(), requestId: lifecycle.requestId, outcome: lifecycle.submitted ? 'outcome_unknown' : 'failed' });
      throw error;
    } finally {
      if (session) session.reservations -= 1;
      if (ownsLifecycle) lifecycle.dispose();
    }
  }

  async reset(requestedId: string | undefined, signal?: AbortSignal): Promise<void> {
    const session = await this.resolve(requestedId);
    try {
      if (!session.executor.reset) throw new SessionNotSupportedError();
      const signalWithShutdown = combinedSignal(signal, this.shutdownController.signal);
      await session.queue.run(async () => {
        session.activeOperations += 1;
        session.status = 'busy';
        try {
          await session.executor.reset!();
          session.generation = ++this.generation;
        } finally {
          session.lastActivity = Date.now();
          session.activeOperations = Math.max(0, session.activeOperations - 1);
          session.status = session.activeOperations > 0 ? 'busy' : 'idle';
        }
      }, signalWithShutdown);
    } finally { session.reservations -= 1; }
  }

  async delete(requestedId: string): Promise<boolean> {
    const id = this.normalizeSessionId(requestedId);
    if (id === 'default') return false;
    const session = this.sessions.get(id);
    if (!session) return false;
    if (
      session.reservations > 0
      || session.status === 'busy'
      || session.queue.depth > 0
      || session.automationQueue.depth > 0
    ) throw new SessionBusyError(id);
    await this.removeSession(session);
    return true;
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()]
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((session) => ({
        id: session.id,
        provider: session.provider,
        created_at: new Date(session.createdAt).toISOString(),
        last_activity: new Date(session.lastActivity).toISOString(),
        status: session.status,
        awaiting_tool_result: awaitsToolResult(session)
      }));
  }

  capacity(): SessionCapacitySnapshot {
    const values = [...this.sessions.values()];
    const browserPages = this.browserPageCount(values);
    const maxBrowserPages = this.options.config.maxBrowserPages ?? 12;
    const busy = values.filter((session) =>
      session.status === 'busy'
      || session.queue.depth > 0
      || session.automationQueue.depth > 0
    ).length;
    const idle = values.filter((session) =>
      session.status === 'idle'
      && session.reservations === 0
      && session.queue.depth === 0
      && session.automationQueue.depth === 0
    ).length;
    const awaitingToolResults = values.filter((session) => awaitsToolResult(session)).length;
    const recyclable = values.filter((session) =>
      !session.isDefault
      && session.reservations === 0
      && session.status === 'idle'
      && session.queue.depth === 0
      && session.automationQueue.depth === 0
      && !awaitsToolResult(session)
    ).length;
    return {
      provider: this.options.provider,
      active: values.length,
      named: values.filter((session) => !session.isDefault).length,
      busy,
      idle,
      pending_creation: this.creating.size,
      recyclable_idle_named: recyclable,
      awaiting_tool_results: awaitingToolResults,
      max: this.options.config.maxSessions,
      idle_timeout_ms: this.options.config.sessionIdleTimeoutMs,
      automation_idle_timeout_ms: this.automationIdleTimeoutMs,
      automation_pages: values.filter((session) =>
        Boolean(session.browserAutomation && !session.browserAutomation.isClosed())
      ).length,
      browser_pages: browserPages,
      max_browser_pages: maxBrowserPages,
      eviction: 'page_lru_idle',
      accepts_named_sessions: Boolean(this.options.factory),
      shutting_down: this.closed
    };
  }

  queueDepth(requestedId?: string): number {
    const id = requestedId ? this.normalizeSessionId(requestedId) : 'default';
    const session = this.sessions.get(id);
    return session ? session.queue.depth + session.automationQueue.depth : 0;
  }

  async sweepIdle(now = Date.now()): Promise<void> {
    if (this.closed) return;
    const timeout = this.options.config.sessionIdleTimeoutMs;
    const automationTimeout = this.automationIdleTimeoutMs;
    const values = [...this.sessions.values()];
    const staleAutomation = values.filter((session) =>
      session.status === 'idle'
      && session.reservations === 0
      && session.queue.depth === 0
      && session.automationQueue.depth === 0
      && session.browserAutomation
      && !session.browserAutomation.isClosed()
      && now - (session.browserAutomationLastActivity ?? session.lastActivity) >= automationTimeout
    );
    for (const session of staleAutomation) {
      // Closing a previous page yields: another request may now hold this session.
      if (session.reservations !== 0 || session.status !== 'idle'
          || session.queue.depth !== 0 || session.automationQueue.depth !== 0) continue;
      const current = session.browserAutomation;
      delete session.browserAutomation;
      delete session.browserAutomationLastActivity;
      await current?.close().catch(() => undefined);
    }

    const stale = values.filter((session) =>
      !session.isDefault
      && session.reservations === 0
      && session.status === 'idle'
      && session.queue.depth === 0
      && session.automationQueue.depth === 0
      && !awaitsToolResult(session)
      && now - session.lastActivity >= timeout
    );
    for (const session of stale) await this.removeSession(session);

    // Only page count may trigger early recycling. Chromium memory usage
    // belongs to Chrome/the OS, regardless of conversation length.
    if (this.browserPageCount() >= (this.options.config.maxBrowserPages ?? 12)) {
      const graceMs = Math.min(timeout, PAGE_PRESSURE_IDLE_GRACE_MS);
      const candidate = this.oldestRecyclableSession(graceMs, now);
      if (candidate) await this.removeSession(candidate);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.shutdownController.abort();
    for (const session of this.sessions.values()) {
      session.queue.close();
      session.automationQueue.close();
    }

    await settleWithin([
      ...this.creating.values(),
      ...(this.defaultRehydration ? [this.defaultRehydration] : [])
    ], SHUTDOWN_DRAIN_TIMEOUT_MS);
    const snapshot = [...this.sessions.values()];
    await settleWithin(
      snapshot.flatMap((session) => [session.queue.drain(), session.automationQueue.drain()]),
      SHUTDOWN_DRAIN_TIMEOUT_MS
    );

    for (const session of snapshot) {
      await session.browserAutomation?.close().catch(() => undefined);
      delete session.browserAutomation;
      delete session.browserAutomationLastActivity;
    }
    for (const session of snapshot) {
      if (!session.isDefault && this.sessions.get(session.id) === session) {
        await this.removeSession(session);
      }
    }
    const defaultSession = this.sessions.get('default');
    await defaultSession?.browserSession?.close().catch(() => undefined);
    if (this.startupTabAdopted) {
      // If first named session was removed, its page may already be closed.
      // This releases the original native Chrome process/profile exactly once.
      await this.options.defaultBrowserSession?.close().catch(() => undefined);
    }
  }

  private get defaultSession(): ManagedSession {
    const session = this.sessions.get('default');
    if (!session) throw new SessionNotSupportedError();
    return session;
  }

  private async resolve(requestedId: string | undefined): Promise<ManagedSession> {
    if (this.closed) throw new SessionNotSupportedError();
    const id = this.normalizeSessionId(requestedId);
    if (id === 'default') {
      this.defaultRouteUsed = true;
      if (this.startupTabAdopted) await this.rehydrateDefaultRoute();
    }
    const current = this.sessions.get(id);
    if (current) { current.reservations += 1; return current; }
    if (!this.options.factory) throw new SessionNotSupportedError();
    const pending = this.creating.get(id);
    if (pending) {
      const session = await pending;
      session.reservations += 1;
      return session;
    }
    const creation = this.create(id);
    this.creating.set(id, creation);
    try { return await creation; }
    finally { this.creating.delete(id); }
  }

  private canAdoptStartupTab(): boolean {
    if (!this.options.reuseStartupTabForFirstNamed || this.startupTabAdopted
        || this.defaultRouteUsed || !this.options.defaultBrowserSession) return false;
    const primary = this.defaultSession;
    return !primary.reservations && !primary.activeOperations && !primary.queue.depth
      && !primary.automationQueue.depth && primary.status === 'idle'
      && !primary.browserAutomation && Boolean(primary.browserSession)
      && !primary.browserSession!.page.isClosed();
  }

  private adoptStartupTab(): SessionFactoryResult | undefined {
    if (!this.canAdoptStartupTab()) return undefined;
    const primary = this.defaultSession;
    this.startupTabAdopted = true;
    const session = primary.browserSession!;
    delete primary.browserSession;
    logger.event('info', 'session.browser.startup_tab_adopted', {
      browser_page_reused: true, extra_tabs_created: 0
    });
    return {
      executor: this.options.defaultExecutor,
      browserSession: {
        ...session,
        // Startup Chrome/profile remains owned by SessionManager until shutdown.
        // Releasing a named lease must never kill its sibling browser contexts.
        async close(): Promise<void> {}
      }
    };
  }

  private async rehydrateDefaultRoute(): Promise<void> {
    if (this.defaultSession.browserSession) return;
    if (!this.options.factory) throw new SessionNotSupportedError();
    if (!this.defaultRehydration) {
      const promise = (async () => {
        const result = await this.options.factory!('default');
        if (this.closed || !result.browserSession) {
          await result.browserSession?.close().catch(() => undefined);
          throw new SessionNotSupportedError();
        }
        const session = this.defaultSession;
        session.executor = resilient(result.executor, this.options.provider, this.circuitStates);
        if (result.browserSession) session.browserSession = result.browserSession;
        session.generation = ++this.generation;
      })();
      this.defaultRehydration = promise;
      void promise.finally(() => { this.defaultRehydration = undefined; }).catch(() => undefined);
    }
    await this.defaultRehydration;
  }

  private async create(id: string): Promise<ManagedSession> {
    await this.ensureCapacity();
    const adopted = this.adoptStartupTab();
    const result = adopted ?? await this.options.factory!(id);
    if (this.closed) {
      await result.browserSession?.close().catch(() => undefined);
      throw new SessionNotSupportedError();
    }
    const now = Date.now();
    const session: ManagedSession = {
      id,
      generation: ++this.generation,
      provider: this.options.provider,
      executor: resilient(result.executor, this.options.provider, this.circuitStates),
      ...(result.browserSession ? { browserSession: result.browserSession } : {}),
      queue: new SerialQueue(this.options.config.maxQueue, this.options.config.minIntervalMs),
      automationQueue: new SerialQueue(this.options.config.maxQueue, 0),
      activeOperations: 0,
      reservations: 1,
      createdAt: now,
      lastActivity: now,
      status: 'idle',
      isDefault: false
    };
    this.sessions.set(id, session);
    telemetry.sessionCreated();
    telemetry.setSessionsActive(this.sessions.size);
    return session;
  }

  private async ensureCapacity(): Promise<void> {
    const atCountLimit =
      this.sessions.size + this.creating.size >= this.options.config.maxSessions;
    const maxBrowserPages = this.options.config.maxBrowserPages ?? 12;
    const atPageLimit = this.browserPageCount() >= maxBrowserPages;

    // Reusing the authenticated startup tab does not create another page.
    if (!atCountLimit && (this.canAdoptStartupTab() || !atPageLimit)) return;

    // Only session-count/page limits may recycle a finished idle session.
    // Active conversations and sessions awaiting tool results remain pinned.
    const candidate = this.oldestRecyclableSession();
    if (candidate) {
      await this.removeSession(candidate);
      // Evicting an idle session does not guarantee it owned a browser page.
      if (!this.canAdoptStartupTab() && this.browserPageCount() >= maxBrowserPages) {
        throw new SessionLimitExceededError();
      }
      return;
    }
    throw new SessionLimitExceededError();
  }

  private oldestRecyclableSession(minIdleMs = 0, now = Date.now()): ManagedSession | undefined {
    return [...this.sessions.values()]
      .filter((session) =>
        !session.isDefault
        && session.reservations === 0
        && session.status === 'idle'
        && session.queue.depth === 0
        && session.automationQueue.depth === 0
        && !awaitsToolResult(session)
        && now - session.lastActivity >= minIdleMs
      )
      .sort((left, right) =>
        left.lastActivity - right.lastActivity || left.createdAt - right.createdAt
      )[0];
  }

  private browserPageCount(values: readonly ManagedSession[] = [...this.sessions.values()]): number {
    const contexts = new Set<object>();
    let pages = 0;
    for (const session of values) {
      const context = session.browserSession?.context;
      if (!context || contexts.has(context)) continue;
      contexts.add(context);
      try {
        pages += context.pages().filter((page) => !page.isClosed()).length;
      } catch {
        // A concurrently closing context contributes no usable page capacity.
      }
    }
    return pages;
  }

  private async removeSession(session: ManagedSession): Promise<void> {
    if (this.sessions.get(session.id) !== session) return;
    if (!this.closed && (session.reservations > 0 || session.queue.depth > 0 || session.automationQueue.depth > 0)) return;
    session.status = 'closing';
    session.queue.close();
    session.automationQueue.close();
    this.sessions.delete(session.id);
    await session.browserAutomation?.close().catch(() => undefined);
    delete session.browserAutomation;
      delete session.browserAutomationLastActivity;
    await session.browserSession?.close().catch(() => undefined);
    if (session.browserSession?.page === this.options.defaultBrowserSession?.page
        && this.startupTabAdopted) {
      const initial = this.options.defaultBrowserSession!;
      // On idle eviction, return the startup tab to the standby default only
      // after clearing its previous agent history. Next named can reclaim it.
      if (!this.closed && !this.defaultRouteUsed && !this.defaultSession.browserSession
          && this.options.defaultExecutor.reset) {
        try {
          await this.options.defaultExecutor.reset();
          this.defaultSession.browserSession = initial;
          this.startupTabAdopted = false;
          logger.event('info', 'session.browser.startup_tab_returned', {
            browser_page_reused: true, history_cleared: true
          });
        } catch {
          // Never transfer a stale conversation to a different session.
          await initial.page.close().catch(() => undefined);
        }
      } else if (this.closed || this.defaultSession.browserSession) {
        await initial.page.close().catch(() => undefined);
      }
      // While a lazy default is being initialized, retain the original tab
      // until shutdown rather than exiting Chrome with zero usable tabs.
    }
    telemetry.sessionEvicted();
    telemetry.setSessionsActive(this.sessions.size);
  }
}

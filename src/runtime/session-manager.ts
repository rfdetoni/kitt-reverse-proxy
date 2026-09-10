import type {
  AppConfig,
  ChatExecutionOptions,
  ChatExecutionResult,
  ChatExecutor,
  JsonObject,
  LiveBrowserSession
} from '../types.js';
import { SerialQueue } from './serial-queue.js';
import { logger } from '../logger.js';
import { telemetry } from '../util/telemetry.js';
import { updateRequestContext } from '../util/request-context.js';

const SESSION_ID = /^[A-Za-z0-9]{1,64}$/;

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
}

export interface SessionCapacitySnapshot {
  provider: string;
  active: number;
  named: number;
  busy: number;
  idle: number;
  pending_creation: number;
  recyclable_idle_named: number;
  max: number;
  idle_timeout_ms: number;
  eviction: 'lru_idle';
  accepts_named_sessions: boolean;
  shutting_down: boolean;
}

interface ManagedSession {
  id: string;
  provider: string;
  executor: ChatExecutor;
  browserSession?: LiveBrowserSession;
  queue: SerialQueue;
  createdAt: number;
  lastActivity: number;
  status: 'idle' | 'busy' | 'closing';
  isDefault: boolean;
}

export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly creating = new Map<string, Promise<ManagedSession>>();
  private readonly timer: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly options: {
    defaultExecutor: ChatExecutor;
    defaultBrowserSession?: LiveBrowserSession;
    provider: string;
    config: AppConfig;
    factory?: SessionFactory;
  }) {
    const now = Date.now();
    this.sessions.set('default', {
      id: 'default',
      provider: options.provider,
      executor: options.defaultExecutor,
      ...(options.defaultBrowserSession ? { browserSession: options.defaultBrowserSession } : {}),
      queue: new SerialQueue(options.config.maxQueue, options.config.minIntervalMs),
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

  normalizeSessionId(value: string | undefined): string {
    if (value === undefined || value === '' || value === 'default') return 'default';
    if (!SESSION_ID.test(value)) throw new InvalidSessionIdError();
    return value;
  }

  async execute(requestedId: string | undefined, body: JsonObject, options?: ChatExecutionOptions): Promise<ChatExecutionResult> {
    const requestStartedAt = Date.now();
    const session = await this.resolve(requestedId);
    const resolvedAt = Date.now();
    updateRequestContext({ sessionId: session.id, provider: session.provider });
    session.lastActivity = Date.now();
    const queuedAt = Date.now();
    return session.queue.run(async () => {
      const dequeuedAt = Date.now();
      const queueWaitMs = Math.max(0, dequeuedAt - queuedAt);
      telemetry.recordQueueWait(session.provider, queueWaitMs);
      session.status = 'busy';
      session.lastActivity = Date.now();
      const executorStartedAt = Date.now();
      try {
        const result = await session.executor.execute(body, options);
        const completedAt = Date.now();
        const timing: JsonObject = {
          session_resolve_ms: Math.max(0, resolvedAt - requestStartedAt),
          queue_wait_ms: queueWaitMs,
          executor_ms: Math.max(0, completedAt - executorStartedAt),
          total_ms: Math.max(0, completedAt - requestStartedAt),
          transport: session.executor.transport,
          ...(result.metadata?.timing !== undefined ? { executor_timing: result.metadata.timing } : {})
        };
        logger.event('info', 'chat.timing', timing);
        return { ...result, metadata: { ...(result.metadata ?? {}), timing } };
      } catch (error) {
        const failedAt = Date.now();
        logger.event('warn', 'chat.timing', {
          session_resolve_ms: Math.max(0, resolvedAt - requestStartedAt),
          queue_wait_ms: queueWaitMs,
          executor_ms: Math.max(0, failedAt - executorStartedAt),
          total_ms: Math.max(0, failedAt - requestStartedAt),
          transport: session.executor.transport,
          outcome: 'error'
        });
        throw error;
      } finally {
        session.lastActivity = Date.now();
        session.status = 'idle';
      }
    }, options?.signal);
  }

  async reset(requestedId: string | undefined, signal?: AbortSignal): Promise<void> {
    const session = await this.resolve(requestedId);
    if (!session.executor.reset) throw new SessionNotSupportedError();
    await session.queue.run(async () => {
      session.status = 'busy';
      try {
        await session.executor.reset!();
      } finally {
        session.lastActivity = Date.now();
        session.status = 'idle';
      }
    }, signal);
  }

  async delete(requestedId: string): Promise<boolean> {
    const id = this.normalizeSessionId(requestedId);
    if (id === 'default') return false;
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.status === 'busy' || session.queue.depth > 0) throw new SessionBusyError(id);
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
        status: session.status
      }));
  }

  capacity(): SessionCapacitySnapshot {
    const values = [...this.sessions.values()];
    const busy = values.filter((session) => session.status === 'busy' || session.queue.depth > 0).length;
    const idle = values.filter((session) => session.status === 'idle' && session.queue.depth === 0).length;
    const recyclable = values.filter((session) => !session.isDefault && session.status === 'idle' && session.queue.depth === 0).length;
    return {
      provider: this.options.provider,
      active: values.length,
      named: values.filter((session) => !session.isDefault).length,
      busy,
      idle,
      pending_creation: this.creating.size,
      recyclable_idle_named: recyclable,
      max: this.options.config.maxSessions,
      idle_timeout_ms: this.options.config.sessionIdleTimeoutMs,
      eviction: 'lru_idle',
      accepts_named_sessions: Boolean(this.options.factory),
      shutting_down: this.closed
    };
  }

  queueDepth(requestedId?: string): number {
    const id = requestedId ? this.normalizeSessionId(requestedId) : 'default';
    return this.sessions.get(id)?.queue.depth ?? 0;
  }

  async sweepIdle(now = Date.now()): Promise<void> {
    if (this.closed) return;
    const timeout = this.options.config.sessionIdleTimeoutMs;
    const stale = [...this.sessions.values()].filter((session) =>
      !session.isDefault && session.status === 'idle' && session.queue.depth === 0 && now - session.lastActivity >= timeout
    );
    for (const session of stale) await this.removeSession(session);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    for (const session of this.sessions.values()) session.queue.close();
    await Promise.allSettled([...this.creating.values()]);
    const snapshot = [...this.sessions.values()];
    await Promise.all(snapshot.map((session) => session.queue.drain()));
    for (const session of snapshot) {
      if (!session.isDefault && this.sessions.get(session.id) === session) await this.removeSession(session);
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
    const current = this.sessions.get(id);
    if (current) return current;
    if (!this.options.factory) throw new SessionNotSupportedError();
    const pending = this.creating.get(id);
    if (pending) return pending;
    const creation = this.create(id);
    this.creating.set(id, creation);
    try { return await creation; }
    finally { this.creating.delete(id); }
  }

  private async create(id: string): Promise<ManagedSession> {
    await this.ensureCapacity();
    const result = await this.options.factory!(id);
    if (this.closed) {
      await result.browserSession?.close().catch(() => undefined);
      throw new SessionNotSupportedError();
    }
    const now = Date.now();
    const session: ManagedSession = {
      id,
      provider: this.options.provider,
      executor: result.executor,
      ...(result.browserSession ? { browserSession: result.browserSession } : {}),
      queue: new SerialQueue(this.options.config.maxQueue, this.options.config.minIntervalMs),
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
    if (this.sessions.size + this.creating.size < this.options.config.maxSessions) return;
    const candidate = [...this.sessions.values()]
      .filter((session) => !session.isDefault && session.status === 'idle' && session.queue.depth === 0)
      .sort((left, right) => left.lastActivity - right.lastActivity || left.createdAt - right.createdAt)[0];
    if (!candidate) throw new SessionLimitExceededError();
    await this.removeSession(candidate);
  }

  private async removeSession(session: ManagedSession): Promise<void> {
    if (this.sessions.get(session.id) !== session) return;
    session.status = 'closing';
    session.queue.close();
    this.sessions.delete(session.id);
    await session.browserSession?.close().catch(() => undefined);
    telemetry.sessionEvicted();
    telemetry.setSessionsActive(this.sessions.size);
  }
}

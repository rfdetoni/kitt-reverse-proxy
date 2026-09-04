import type {
  AppConfig,
  ChatExecutionOptions,
  ChatExecutionResult,
  ChatExecutor,
  JsonObject,
  LiveBrowserSession
} from '../types.js';
import { SerialQueue } from './serial-queue.js';
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

export interface SessionFactoryResult {
  executor: ChatExecutor;
  browserSession?: LiveBrowserSession;
}

export type SessionFactory = (id: string) => Promise<SessionFactoryResult>;

export interface SessionInfo {
  id: string;
  provider: string;
  criada_em: string;
  ultima_atividade: string;
  status: 'idle' | 'busy' | 'closing';
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

  get modelId(): string {
    return this.sessions.get('default')!.executor.modelId;
  }

  get transport(): ChatExecutor['transport'] {
    return this.sessions.get('default')!.executor.transport;
  }

  normalizeSessionId(value: string | undefined): string {
    if (value === undefined || value === '') return 'default';
    if (value === 'default') return 'default';
    if (!SESSION_ID.test(value)) throw new InvalidSessionIdError();
    return value;
  }

  async execute(
    requestedId: string | undefined,
    body: JsonObject,
    options?: ChatExecutionOptions
  ): Promise<ChatExecutionResult> {
    const session = await this.resolve(requestedId);
    updateRequestContext({ sessionId: session.id, provider: session.provider });
    session.lastActivity = Date.now();
    return session.queue.run(async () => {
      session.status = 'busy';
      session.lastActivity = Date.now();
      try {
        return await session.executor.execute(body, options);
      } finally {
        session.lastActivity = Date.now();
        session.status = 'idle';
      }
    });
  }

  async reset(requestedId: string | undefined): Promise<void> {
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
    });
  }

  async delete(requestedId: string): Promise<boolean> {
    const id = this.normalizeSessionId(requestedId);
    if (id === 'default') return false;
    const session = this.sessions.get(id);
    if (!session) return false;
    session.status = 'closing';
    this.sessions.delete(id);
    await session.browserSession?.close().catch(() => undefined);
    telemetry.sessionEvicted();
    telemetry.setSessionsActive(this.sessions.size);
    return true;
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()]
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((session) => ({
        id: session.id,
        provider: session.provider,
        criada_em: new Date(session.createdAt).toISOString(),
        ultima_atividade: new Date(session.lastActivity).toISOString(),
        status: session.status
      }));
  }

  queueDepth(requestedId?: string): number {
    const id = requestedId ? this.normalizeSessionId(requestedId) : 'default';
    return this.sessions.get(id)?.queue.depth ?? 0;
  }

  async sweepIdle(now = Date.now()): Promise<void> {
    const timeout = this.options.config.sessionIdleTimeoutMs;
    const stale = [...this.sessions.values()].filter((session) =>
      !session.isDefault
      && session.status === 'idle'
      && session.queue.depth === 0
      && now - session.lastActivity >= timeout
    );
    await Promise.all(stale.map((session) => this.delete(session.id)));
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    const named = [...this.sessions.values()].filter((session) => !session.isDefault);
    await Promise.all(named.map((session) => this.delete(session.id)));
  }

  private async resolve(requestedId: string | undefined): Promise<ManagedSession> {
    const id = this.normalizeSessionId(requestedId);
    const current = this.sessions.get(id);
    if (current) return current;
    if (!this.options.factory) throw new SessionNotSupportedError();

    const pending = this.creating.get(id);
    if (pending) return pending;

    const creation = this.create(id);
    this.creating.set(id, creation);
    try {
      return await creation;
    } finally {
      this.creating.delete(id);
    }
  }

  private async create(id: string): Promise<ManagedSession> {
    if (this.sessions.size >= this.options.config.maxSessions) throw new SessionLimitExceededError();
    const result = await this.options.factory!(id);
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
}

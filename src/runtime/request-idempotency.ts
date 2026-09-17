import { createHash } from 'node:crypto';

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ENTRIES = 512;

interface Entry<T> {
  fingerprint: string;
  promise: Promise<T>;
  expiresAt: number;
}

export class RequestIdConflictError extends Error {
  constructor(public readonly requestId: string) {
    super(`X-Kitt-Request-Id ${requestId} foi reutilizado com payload diferente.`);
    this.name = 'RequestIdConflictError';
  }
}

function fingerprint(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export class RequestIdempotencyCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES
  ) {}

  execute(
    scope: string,
    requestId: string | undefined,
    payload: unknown,
    factory: () => Promise<T>
  ): Promise<T> {
    const normalizedRequestId = requestId?.trim();
    if (!normalizedRequestId) return factory();

    this.prune();
    const key = `${scope}\u0000${normalizedRequestId}`;
    const digest = fingerprint(payload);
    const current = this.entries.get(key);
    if (current) {
      if (current.fingerprint !== digest) throw new RequestIdConflictError(normalizedRequestId);
      return current.promise;
    }

    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest) this.entries.delete(oldest);
    }

    const promise = factory();
    this.entries.set(key, {
      fingerprint: digest,
      promise,
      expiresAt: Date.now() + this.ttlMs
    });
    return promise;
  }

  private prune(now = Date.now()): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

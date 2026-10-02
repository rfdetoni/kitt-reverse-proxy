import { QueueFullError } from './serial-queue.js';
import { createHash } from 'node:crypto';

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ENTRIES = 512;

interface Entry<T> {
  fingerprint: string;
  promise: Promise<T>;
  expiresAt: number;
  pending: boolean;
  uncertain: boolean;
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
    factory: () => Promise<T>,
    options: { submitted?: () => boolean } = {}
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
      const oldest = [...this.entries].find(([, entry]) => !entry.pending && !entry.uncertain)?.[0];
      if (oldest) this.entries.delete(oldest);
      else return Promise.reject(new QueueFullError());
    }

    const entry: Entry<T> = { fingerprint: digest, promise: Promise.resolve().then(factory),
      pending: true, uncertain: false, expiresAt: Number.POSITIVE_INFINITY };
    this.entries.set(key, entry);
    entry.promise = entry.promise.then((result) => {
      entry.pending = false; entry.expiresAt = Date.now() + this.ttlMs; return result;
    }, (error: unknown) => {
      entry.pending = false;
      if (options.submitted?.()) entry.uncertain = true;
      else if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    });
    return entry.promise;
  }

  private prune(now = Date.now()): void {
    for (const [key, entry] of this.entries) {
      if (!entry.pending && !entry.uncertain && entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

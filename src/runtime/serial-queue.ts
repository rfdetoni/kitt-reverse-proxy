export class QueueFullError extends Error {
  constructor() {
    super('Fila do proxy cheia. Tente novamente mais tarde.');
    this.name = 'QueueFullError';
  }
}

export class RequestAbortedError extends Error {
  constructor() {
    super('A requisição foi cancelada pelo cliente.');
    this.name = 'RequestAbortedError';
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RequestAbortedError();
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(new RequestAbortedError());
    };
    function cleanup(): void {
      signal?.removeEventListener('abort', onAbort);
    }
    function done(): void {
      cleanup();
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;
  private lastStart = 0;
  private closed = false;

  constructor(private readonly maxQueue: number, private readonly minIntervalMs: number) {}

  get depth(): number { return this.queued; }

  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new RequestAbortedError());
    if (signal?.aborted) return Promise.reject(new RequestAbortedError());
    if (this.queued >= this.maxQueue) return Promise.reject(new QueueFullError());
    this.queued += 1;

    const execute = async (): Promise<T> => {
      try {
        throwIfAborted(signal);
        const waitMs = Math.max(0, this.lastStart + this.minIntervalMs - Date.now());
        await delay(waitMs, signal);
        throwIfAborted(signal);
        this.lastStart = Date.now();
        return await task();
      } finally {
        this.queued -= 1;
      }
    };

    const result = this.tail.then(execute, execute);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  close(): void {
    this.closed = true;
  }

  /** Resolves once all work accepted before this call has finished. */
  drain(): Promise<void> {
    return this.tail;
  }
}

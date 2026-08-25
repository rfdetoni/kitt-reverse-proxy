export class QueueFullError extends Error {
  constructor() {
    super('Fila do proxy cheia. Tente novamente mais tarde.');
    this.name = 'QueueFullError';
  }
}

export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;
  private lastStart = 0;

  constructor(private readonly maxQueue: number, private readonly minIntervalMs: number) {}

  get depth(): number { return this.queued; }

  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.queued >= this.maxQueue) return Promise.reject(new QueueFullError());
    this.queued += 1;

    const execute = async (): Promise<T> => {
      try {
        const waitMs = Math.max(0, this.lastStart + this.minIntervalMs - Date.now());
        if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
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
}

import { abortableSleep, throwIfAborted } from './cancellation.js';
export class QueueFullError extends Error {
  constructor() { super('Proxy queue capacity exhausted.'); this.name = 'QueueFullError'; }
}
export class RequestAbortedError extends Error {
  constructor() { super('The request was cancelled.'); this.name = 'RequestAbortedError'; }
}
export class SerialQueue {
  private readonly pending: Array<{ start(): Promise<void>; cancel(): void }> = [];
  private readonly accepted = new Set<Promise<unknown>>();
  private active = false;
  private lastStart = 0;
  private closed = false;
  constructor(private readonly maxQueue: number, private readonly minIntervalMs: number) {}
  get depth(): number { return this.pending.length + Number(this.active); }
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new RequestAbortedError());
    try { throwIfAborted(signal); } catch (error) { return Promise.reject(error); }
    if (this.depth >= this.maxQueue) return Promise.reject(new QueueFullError());
    const result = new Promise<T>((resolve, reject) => {
      const cleanup = (): void => signal?.removeEventListener('abort', abort);
      const entry = {
        cancel: (): void => { cleanup(); reject(signal?.reason instanceof Error && signal.reason.name === 'RequestDeadlineError' ? signal.reason : new RequestAbortedError()); },
        start: async (): Promise<void> => {
          cleanup();
          try {
            throwIfAborted(signal);
            await abortableSleep(Math.max(0, this.lastStart + this.minIntervalMs - Date.now()), signal);
            throwIfAborted(signal); this.lastStart = Date.now(); resolve(await task());
          } catch (error) { reject(error); }
        }
      };
      const abort = (): void => {
        const index = this.pending.indexOf(entry);
        if (index >= 0) { this.pending.splice(index, 1); entry.cancel(); }
      };
      this.pending.push(entry); signal?.addEventListener('abort', abort, { once: true });
      queueMicrotask(() => void this.pump());
    });
    this.accepted.add(result);
    void result.then(() => this.accepted.delete(result), () => this.accepted.delete(result));
    return result;
  }
  private async pump(): Promise<void> {
    if (this.active) return;
    const entry = this.pending.shift(); if (!entry) return;
    this.active = true;
    try { await entry.start(); } finally { this.active = false; void this.pump(); }
  }
  close(): void { this.closed = true; for (const entry of this.pending.splice(0)) entry.cancel(); }
  drain(): Promise<void> { return Promise.allSettled([...this.accepted]).then(() => undefined); }
}

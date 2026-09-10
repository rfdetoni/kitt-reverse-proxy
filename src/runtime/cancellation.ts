import { RequestAbortedError } from './serial-queue.js';

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RequestAbortedError();
}

export async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    throwIfAborted(signal);
    return;
  }
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

import type { Response } from 'express';
import { RequestAbortedError } from '../runtime/serial-queue.js';
export class SlowConsumerError extends Error {
  constructor() { super('The client exceeded the bounded stream buffer/drain deadline.'); this.name = 'SlowConsumerError'; }
}
export function writeStreamChunk(res: Response, chunk: string): boolean {
  if (res.destroyed || res.writableEnded) throw new RequestAbortedError();
  if ((res.writableLength ?? 0) + Buffer.byteLength(chunk) > 4 * 1024 * 1024) throw new SlowConsumerError();
  return res.write(chunk) !== false;
}
export async function waitForDrain(res: Response): Promise<void> {
  if (res.destroyed || res.writableEnded) throw new RequestAbortedError();
  if (!res.writableNeedDrain) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => { clearTimeout(timer); res.removeListener('drain', drained); res.removeListener('close', closed); };
    const drained = (): void => { cleanup(); resolve(); };
    const closed = (): void => { cleanup(); reject(new RequestAbortedError()); };
    const timer = setTimeout(() => { cleanup(); reject(new SlowConsumerError()); }, 10_000);
    res.once('drain', drained); res.once('close', closed);
  });
}

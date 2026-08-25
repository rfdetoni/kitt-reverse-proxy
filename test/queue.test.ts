import test from 'node:test';
import assert from 'node:assert/strict';
import { QueueFullError, SerialQueue } from '../src/runtime/serial-queue.js';

test('serial queue preserves execution order', async () => {
  const queue = new SerialQueue(4, 0);
  const order: number[] = [];
  await Promise.all([
    queue.run(async () => { await new Promise((r) => setTimeout(r, 20)); order.push(1); }),
    queue.run(async () => { order.push(2); })
  ]);
  assert.deepEqual(order, [1, 2]);
});

test('serial queue rejects beyond bounded capacity', async () => {
  const queue = new SerialQueue(1, 0);
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => { release = resolve; });
  const first = queue.run(async () => blocker);
  await assert.rejects(queue.run(async () => undefined), QueueFullError);
  release();
  await first;
});

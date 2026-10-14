import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncEventQueue } from '../src/runtime/read/tap-queue.js';

test('tap queue drains buffered events in order after close', async () => {
  const queue = new AsyncEventQueue<number>();
  for (let value = 0; value < 4_096; value++) queue.push(value);
  queue.close();
  queue.push(10_000);
  const received: number[] = [];
  for await (const item of queue.events()) received.push(item);
  assert.deepEqual(received, Array.from({ length: 4_096 }, (_, i) => i));
});

test('tap queue hands new events directly to a waiting consumer', async () => {
  const queue = new AsyncEventQueue<string>();
  const stream = queue.events()[Symbol.asyncIterator]();
  const pending = stream.next();
  queue.push('first');
  assert.deepEqual(await pending, { value: 'first', done: false });
  queue.close();
  assert.equal((await stream.next()).done, true);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { completedRawContract } from '../src/runtime/read/contract-text.js';
import { HybridUiResponseReader } from '../src/runtime/read/hybrid-reader.js';
import { UiTimeoutError, ManualInterventionRequiredError } from '../src/runtime/ui-errors.js';
import type { TapTurn } from '../src/runtime/read/types.js';
import { abortableSleep } from '../src/runtime/cancellation.js';

test('DOM timeout recovery requires a trusted strict complete contract', () => {
  const raw = '{"name":"read_file","arguments":{"path":"a.txt"}}';
  assert.equal(completedRawContract(raw, '', true), raw);
  assert.equal(completedRawContract(raw, '', false), undefined);
  assert.equal(completedRawContract('{"name":"read_file",}', '', true), undefined);
  assert.equal(completedRawContract('incomplete', '', true), undefined);
  assert.throws(() => completedRawContract(raw, '{"name":"read_file","arguments":{"path":"b.txt"}}', true), /different valid/);
});

test('hybrid reader preserves completed CDP on DOM timeout but honors cancellation and intervention', async () => {
  const raw = '{"name":"read_file","arguments":{"path":"a.txt"}}';
  for (const failure of [new UiTimeoutError('timeout'), new ManualInterventionRequiredError('login'), new Error('aborted')]) {
    const turn: TapTurn = {
      mode: 'active',
      profile: { endpointOrigin: 'https://fixture.invalid', endpointPath: '/chat', method: 'POST', contentType: 'text/event-stream', framing: 'sse', textPath: '$.delta', textMode: 'delta' },
      cancel() {},
      async *events() {
        yield { type: 'matched', requestId: 'fixture', url: 'https://fixture.invalid/chat', method: 'POST', contentType: 'text/event-stream', t: 0 };
        yield { type: 'chunk', bytes: Buffer.from(`data: ${JSON.stringify({ delta: raw })}\n\ndata: [DONE]\n\n`), t: 1 };
        yield { type: 'end', ok: true, t: 2 };
      }
    };
    const reader = Object.create(HybridUiResponseReader.prototype) as HybridUiResponseReader;
    Object.assign(reader, { pending: turn, config: { readMode: 'auto' }, tap: { health: () => ({ trusted: true }), recordFailure() {}, recordVerified() {} },
      monitor: async () => { await new Promise(resolve => setImmediate(resolve)); throw failure; } });
    if (failure instanceof UiTimeoutError) assert.equal((await reader.read([], 'prompt', undefined, undefined, true)).text, raw);
    else await assert.rejects(reader.read([], 'prompt', undefined, undefined, true), error => error === failure);
  }
});

test('hybrid reader propagates consumer failure and stops its DOM monitor', async () => {
  const failure = new Error('downstream disconnected');
  const failures: string[] = [];
  let cancelled = false;
  let monitorAborted = false;
  const turn: TapTurn = {
    mode: 'active',
    profile: { endpointOrigin: 'https://fixture.invalid', endpointPath: '/chat', method: 'POST', contentType: 'text/event-stream', framing: 'sse', textPath: '$.delta', textMode: 'delta' },
    cancel() { cancelled = true; },
    async *events() {
      yield { type: 'matched', requestId: 'fixture', url: 'https://fixture.invalid/chat', method: 'POST', contentType: 'text/event-stream', t: 0 };
      yield { type: 'chunk', bytes: Buffer.from('data: {"delta":"a"}\n\n'), t: 1 };
      yield { type: 'end', ok: true, t: 2 };
    }
  };
  const reader = Object.create(HybridUiResponseReader.prototype) as HybridUiResponseReader;
  Object.assign(reader, {
    pending: turn, config: { readMode: 'auto' },
    tap: { health: () => ({ trusted: true }), recordFailure(reason: string) { failures.push(reason); }, recordVerified() {} },
    monitor: async (...args: Parameters<typeof import('../src/runtime/ui-response-monitor.js').awaitUiResponse>) => {
      const signal = args[6];
      try { await abortableSleep(100, signal); }
      catch (error) { monitorAborted = Boolean(signal?.aborted); throw error; }
      return { text: 'b', deltas: ['b'], durationMs: 100 };
    }
  });
  await assert.rejects(reader.read([], 'prompt', () => { throw failure; }), error => error === failure);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
  assert.equal(monitorAborted, true);
  assert.deepEqual(failures, []);
});

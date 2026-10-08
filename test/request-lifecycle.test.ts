import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestIdempotencyCache } from '../src/runtime/request-idempotency.js';
import { SerialQueue, QueueFullError, RequestAbortedError } from '../src/runtime/serial-queue.js';
import { ProviderRequestState, AttemptBudgetError, RequestDeadlineError } from '../src/runtime/request-state.js';
import { ResponseReconciler, StreamMismatchError } from '../src/runtime/read/reconciler.js';
import { ChatStreamWriter, ResponsesStreamWriter } from '../src/proxy/openai.js';
import { AnthropicStreamWriter } from '../src/proxy/anthropic.js';
import { withEstimatedUsage } from '../src/proxy/token-usage.js';

const completion = { id: 'x', object: 'chat.completion' as const, created: 1, model: 'web', choices: [{ index: 0, message: { role: 'assistant' as const, content: 'canonical' }, finish_reason: 'stop' }] };

test('pending idempotency survives TTL and capacity pressure; pre-submit failures can be retried', async () => {
  const cache = new RequestIdempotencyCache<number>(1, 1);
  let calls = 0; let resolve!: (value: number) => void;
  const first = cache.execute('s', 'a', {}, () => { calls++; return new Promise((r) => { resolve = r; }); });
  await new Promise((r) => setTimeout(r, 5));
  const duplicate = cache.execute('s', 'a', {}, async () => { calls++; return 2; });
  await assert.rejects(cache.execute('s', 'b', {}, async () => 3), QueueFullError);
  resolve(1); assert.equal(await duplicate, 1); assert.equal(await first, 1); assert.equal(calls, 1);
  const failures = new RequestIdempotencyCache<number>();
  await assert.rejects(failures.execute('s', 'a', {}, async () => { throw new Error('before submit'); }));
  assert.equal(await failures.execute('s', 'a', {}, async () => 4), 4);
});

test('uncertain submitted failures are pinned and never dispatched again', async () => {
  const cache = new RequestIdempotencyCache<number>(1, 1); let calls = 0;
  const factory = async (): Promise<number> => { calls++; throw new Error('lost acknowledgement'); };
  await assert.rejects(cache.execute('s', 'a', {}, factory, { submitted: () => true }));
  await assert.rejects(cache.execute('s', 'a', {}, factory));
  await assert.rejects(cache.execute('s', 'b', {}, async () => 3), QueueFullError);
  assert.equal(calls, 1);
});

test('queued cancellation releases capacity immediately without executing the cancelled entry', async () => {
  const queue = new SerialQueue(2, 0); let finish!: () => void; let cancelledRan = false;
  const active = queue.run(() => new Promise<void>((r) => { finish = r; }));
  await Promise.resolve();
  const abort = new AbortController();
  const waiting = queue.run(async () => { cancelledRan = true; }, abort.signal);
  abort.abort(); await assert.rejects(waiting, RequestAbortedError);
  assert.equal(queue.depth, 1);
  const next = queue.run(async () => 3);
  finish(); await active; assert.equal(await next, 3); assert.equal(cancelledRan, false);
  await queue.drain(); queue.close();
});

test('one lifecycle charges hidden attempts cumulatively and respects a whole-request deadline', async () => {
  const lifecycle = new ProviderRequestState({ maxAttempts: 2, maxPromptTokens: 1, timeoutMs: 15 });
  try {
    lifecycle.beforeSubmit('first prompt'); lifecycle.received('candidate'); lifecycle.beforeSubmit('repair prompt');
    assert.throws(() => lifecycle.beforeSubmit('third'), AttemptBudgetError);
    assert.equal(lifecycle.usage().upstream_attempts, 2);
    assert.equal(lifecycle.usage(true).total_tokens, 0);
    await new Promise((r) => setTimeout(r, 20));
    assert.throws(() => lifecycle.beforeSubmit('later'), RequestDeadlineError);
  } finally { lifecycle.dispose(); }
});

test('WebChat token usage is telemetry even beyond the former million-token ceiling', () => {
  const lifecycle = new ProviderRequestState({ maxAttempts: 1 });
  try {
    lifecycle.beforeSubmit('x'.repeat(4_100_000));
    lifecycle.received('y'.repeat(4_100_000));
    assert.ok(Number(lifecycle.usage().prompt_tokens) > 1_000_000);
    assert.ok(Number(lifecycle.usage().completion_tokens) > 1_000_000);
    assert.throws(() => lifecycle.beforeSubmit('another attempt'), AttemptBudgetError);
  } finally { lifecycle.dispose(); }
});

test('live response rewrites fail explicitly; buffered rewrites yield only canonical text', async () => {
  const buffered = new ResponseReconciler('dom', 'disabled', undefined);
  await buffered.domDelta('draft'); const final = await buffered.finalize('canonical', false, false);
  assert.equal(final.deltas.join(''), 'canonical');
  const live = new ResponseReconciler('dom', 'disabled', async () => {});
  await live.domDelta('draft'); await assert.rejects(live.finalize('canonical', false, false), StreamMismatchError);
});

test('tap fallback waits for a lagging DOM without replaying delivered bytes', async () => {
  const delivered: string[] = [];
  const live = new ResponseReconciler('auto', 'active', delta => { delivered.push(delta); });
  await live.tapDelta('abcd');
  await live.fallback('stall');
  await live.domDelta('a');
  await live.domDelta('bcde');
  await live.finalize('abcde', true, true);
  assert.deepEqual(delivered, ['abcd', 'e']);
  // A shorter final response is divergence, even when it is a source prefix.
  await assert.rejects(live.finalize('abc', false, false), StreamMismatchError);
});

test('OpenAI, Responses and Anthropic refuse success after a divergent stream', () => {
  for (const Writer of [ChatStreamWriter, ResponsesStreamWriter, AnthropicStreamWriter]) {
    let output = '';
    const res = { status() { return this; }, setHeader() {}, flushHeaders() {}, write(s: string) { output += s; return true; }, end() {}, once() {}, on() {}, removeListener() {} };
    const writer = new Writer(res as never, 'web', 0);
    writer.delta('draft'); assert.throws(() => writer.finish(completion), StreamMismatchError);
    assert.doesNotMatch(output, /\[DONE\]|response.completed|message_stop/);
  }
  const replay = { ...completion, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, kitt_replay: true } };
  assert.equal(withEstimatedUsage(replay, { messages: ['hello'] }).usage?.total_tokens, 0);
});

test('internal UI repairs retain task/context/tools and candidate as bounded evidence', async () => {
  const { buildUiRepairEvidence } = await import('../src/runtime/ui-executor.js');
  const prompt = buildUiRepairEvidence('Return valid JSON.', { messages: [{ role: 'user', content: 'original task' }], kitt_context: { epoch: 'test' }, tools: [{ name: 'read_file' }] }, 'invalid candidate');
  assert.match(prompt, /original task/); assert.match(prompt, /read_file/); assert.match(prompt, /invalid candidate/); assert.match(prompt, /untrusted evidence/);
  assert.throws(() => buildUiRepairEvidence('Repair.', {}, 'x'.repeat(256 * 1024)), /exceeds 256 KiB/);
});

test('successful replay values are evicted under a byte budget while pending work stays protected', async () => {
  const cache = new RequestIdempotencyCache<string>(60_000, 512, 16);
  let calls = 0;
  const factory = async () => { calls++; return 'x'.repeat(32); };
  await cache.execute('s', 'a', {}, factory); await cache.execute('s', 'a', {}, factory);
  assert.equal(calls, 2); // Successful values exceeding the configured cache budget are not retained.
});

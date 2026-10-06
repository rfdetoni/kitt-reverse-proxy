import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { HybridUiResponseReader } from '../dist/runtime/read/hybrid-reader.js';
import { abortableSleep } from '../dist/runtime/cancellation.js';

test('real Chromium hybrid reader preserves contracts and stops failed delivery', {timeout: 30_000}, async () => {
  const expected = JSON.stringify({action: 'final_response', tool: null, tool_input: null, content: '    <div>ação 😀</div>\n\nline\nline  ', reasoning_summary: '', loop: null});
  const receivedPrompts = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
      response.end('<!doctype html><pre id="answer">renderer-damaged-contract</pre>');
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    receivedPrompts.push(body.messages[0].content);
    response.writeHead(200, {'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store'});
    response.flushHeaders();
    const newline = body.newline;
    const pieces = [expected.slice(0, 20), expected.slice(20, 75), expected.slice(75)];
    for (const piece of pieces) {
      const wire = Buffer.from('data: ' + JSON.stringify({delta: piece}) + newline + newline);
      const multibyte = wire.findIndex(byte => byte >= 0x80);
      const split = multibyte < 0 ? Math.floor(wire.length / 2) : multibyte + 1;
      response.write(wire.subarray(0, split));
      await delay(15);
      response.write(wire.subarray(split));
      await delay(25);
    }
    response.end('data: [DONE]' + newline + newline);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({headless: true});
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(origin);
    await page.locator('#answer').evaluate((element, text) => { element.textContent = text; }, expected);
    let fetchedDone = true;
    let monitorAborted = false;
    const reader = new HybridUiResponseReader({context, page}, {id: 'chatgpt'}, {targetUrl: origin, allowedEndpointHosts: [], readMode: 'auto', tapVerifyTurns: 1, tapMatchTimeoutMs: 5_000, tapFirstByteMs: 5_000, tapStallMs: 5_000}, async (...args) => {
      const signal = args[6];
      try { while (!fetchedDone) await abortableSleep(10, signal); }
      catch (error) { monitorAborted = Boolean(signal?.aborted); throw error; }
      return {text: await page.locator('#answer').textContent(), deltas: [], durationMs: 0};
    });
    await reader.initialize();
    assert.equal(reader.describe().tap.attached, true);
    const fetchTurn = (prompt, newline) => {
      fetchedDone = false;
      const pending = page.evaluate(async ({prompt, newline}) => {
        const response = await fetch('/backend-api/conversation', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({messages: [{role: 'user', content: prompt}], newline})});
        await response.text();
      }, {prompt, newline}).finally(() => { fetchedDone = true; });
      void pending.catch(() => undefined);
      return pending;
    };

    for (const [index, newline] of ['\n', '\r\n', '\r'].entries()) {
      const prompt = `CURRENT UNIQUE TASK ${index}: preserve raw source text`;
      reader.arm(prompt);
      const fetched = fetchTurn(prompt, newline);
      const [result] = await Promise.all([reader.read([], prompt, undefined, undefined, true), fetched]);
      assert.equal(result.text, expected);
      assert.equal(result.readDiagnostics.tap_trusted, true);
      if (index === 0) {
        assert.equal(result.readDiagnostics.tap_verified, true);
        await page.locator('#answer').evaluate(element => { element.textContent = 'renderer-damaged-contract'; });
      } else {
        assert.equal(result.readDiagnostics.tap_mode, 'active');
        assert.equal(await page.locator('#answer').textContent(), 'renderer-damaged-contract');
      }
    }
    const failure = new Error('downstream disconnected');
    const prompt = 'CURRENT UNIQUE FAILED DELIVERY TASK';
    reader.arm(prompt);
    const fetched = fetchTurn(prompt, '\n');
    await assert.rejects(reader.read([], prompt, () => { throw failure; }, undefined, true), error => error === failure);
    await fetched;
    assert.equal(monitorAborted, true);
    assert.equal(reader.describe().tap.trusted, true);
    assert.equal(receivedPrompts.length, 4);
    assert.equal(new Set(receivedPrompts).size, 4);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

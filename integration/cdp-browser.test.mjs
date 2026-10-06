import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { CdpStreamTap } from '../dist/runtime/read/tap-cdp.js';
import { TapStreamAdapter } from '../dist/runtime/read/tap-adapter.js';
import { completedRawContract } from '../dist/runtime/read/contract-text.js';

test('real Chromium CDP preserves completed contracts independently of damaged HTML', {timeout: 30_000}, async () => {
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
  let tap;
  try {
    browser = await chromium.launch({headless: true});
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(origin);
    await page.locator('#answer').evaluate((element, text) => { element.textContent = text; }, expected);
    tap = new CdpStreamTap({context, page}, {id: 'chatgpt'}, {targetUrl: origin, allowedEndpointHosts: [], readMode: 'auto', tapVerifyTurns: 1, tapMatchTimeoutMs: 5_000, tapFirstByteMs: 5_000, tapStallMs: 5_000});
    await tap.initialize();
    assert.equal(tap.health().attached, true);

    for (const [index, newline] of ['\n', '\r\n', '\r'].entries()) {
      const prompt = `CURRENT UNIQUE TASK ${index}: preserve raw source text`;
      const turn = tap.arm(prompt);
      const adapter = new TapStreamAdapter(turn.profile, true);
      let ended = false;
      const consuming = (async () => {
        for await (const event of turn.events()) {
          if (event.type === 'error') assert.fail(event.reason);
          if (event.type === 'matched') adapter.matchedResponse(event.url, event.method, event.contentType);
          if (event.type === 'chunk') adapter.push(event.bytes);
          if (event.type === 'end') { assert.equal(event.ok, true); adapter.end(); ended = true; }
        }
      })();
      // Attach rejection handling immediately while the browser request is running.
      const fetched = page.evaluate(async ({prompt, newline}) => {
        const response = await fetch('/backend-api/conversation', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({messages: [{role: 'user', content: prompt}], newline})});
        await response.text();
      }, {prompt, newline});
      await Promise.all([consuming, fetched]);
      assert.equal(ended, true);
      assert.equal(adapter.accumulatedText(), expected);
      if (index === 0) {
        const verified = adapter.verification(await page.locator('#answer').textContent());
        assert.ok(verified);
        tap.recordVerified(verified.profile);
        await page.locator('#answer').evaluate(element => { element.textContent = 'renderer-damaged-contract'; });
      } else {
        assert.equal(turn.mode, 'active');
        assert.equal(await page.locator('#answer').textContent(), 'renderer-damaged-contract');
        assert.equal(completedRawContract(adapter.accumulatedText(), adapter.accumulatedAlternativeText(), ended && tap.health().trusted), expected);
      }
    }
    assert.equal(receivedPrompts.length, 3);
    assert.equal(new Set(receivedPrompts).size, 3);
  } finally {
    await tap?.detach();
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

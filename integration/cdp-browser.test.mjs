import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { HybridUiResponseReader } from '../dist/runtime/read/hybrid-reader.js';
import { abortableSleep } from '../dist/runtime/cancellation.js';
import { UiChatExecutor } from '../dist/runtime/ui-executor.js';
import { detectProvider } from '../dist/providers/catalog.js';
import { collectVisibleSnapshots, extractArtifactContents } from '../dist/runtime/ui-dom.js';
import { parseContractJson } from '../dist/util/contract-json.js';
import { readFileSync } from 'node:fs';
import { sendUiPrompt } from '../dist/runtime/ui-interaction.js';
import { awaitUiResponse } from '../dist/runtime/ui-response-monitor.js';
import { UiAutomationError } from '../dist/runtime/ui-errors.js';

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

test('real Chromium DOM preserves the logged Gemini contract beside code artifacts', {timeout: 30_000}, async () => {
  const candidate = readFileSync('test/fixtures/gemini-mirrored-contract.txt', 'utf8').trim();
  const browser = await chromium.launch({headless:true});
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent('<!doctype html><body></body>');
    const provider = detectProvider('https://gemini.google.com/app');
    const ui = new UiChatExecutor({context,page,persistent:false}, provider, {targetUrl:'https://gemini.google.com/app',allowedEndpointHosts:[],readMode:'dom',toolEnforcement:'off'});
    Object.assign(ui, {
      sendPrompt: async () => {
        await page.setContent('<model-response><message-content id="answer" style="display:block;white-space:pre-wrap"></message-content></model-response><article><pre><code class="language-typescript">export const unrelated = 1;\n</code></pre></article>');
        await page.locator('#answer').evaluate((element,text) => {element.textContent=text;}, candidate);
      },
      awaitResponse: async () => {
        const snapshots = await collectVisibleSnapshots(page, provider.ui.responseSelectors);
        const text = snapshots.find(snapshot => snapshot.selector === 'model-response message-content')?.text;
        assert.equal(text, candidate);
        return {text,deltas:[text],durationMs:0};
      }
    });
    const result = await ui.execute({messages:[{role:'user',content:'Inspect the workspace.'}]}, {preferRawContract:true});
    assert.equal((await extractArtifactContents(page)).length, 1);
    const text = result.completion.choices[0].message.content;
    assert.equal(text, candidate);
    assert.deepEqual(parseContractJson(text).value.tool_input, {operation:'repo.list',arguments:{path:'.'}});
  } finally { await browser.close(); }
});

test('real Chromium requires submission acceptance and monitors semantic generation controls', {timeout: 30_000}, async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const session = {context, page};
    const provider = detectProvider('https://gemini.google.com/app');
    const config = {manualInterventionTimeoutMs: 1_000, uiResponseTimeoutMs: 1_000, uiSettleMs: 100, headed: false};
    await page.setContent(`<rich-textarea><div id="draft" class="ql-editor" contenteditable="true"></div></rich-textarea>
      <button aria-label="Send message" onclick="window.clicks=(window.clicks||0)+1">Send</button>`);
    await assert.rejects(sendUiPrompt(session, provider, config, 'Current task'), error => error instanceof UiAutomationError && /confirm/i.test(error.message));
    assert.equal(await page.evaluate(() => window.clicks), 1);
    assert.equal(await page.locator('#draft').innerText(), 'Current task');

    // Acceptance can leave the editor populated while a fast response arrives.
    await page.locator('button').evaluate(button => {
      button.onclick = () => {
        const answer = document.createElement('model-response');
        answer.textContent = 'Accepted answer';
        document.body.append(answer);
      };
    });
    await sendUiPrompt(session, provider, config, 'Next task');
    assert.equal(await page.locator('model-response').innerText(), 'Accepted answer');

    await page.setContent(`<rich-textarea><div id="draft" class="ql-editor" contenteditable="true"></div></rich-textarea>
      <button id="send" aria-label="Send message">Send</button>
      <button id="stop" aria-label="Stop output" hidden>Stop</button>`);
    await page.locator('#send').evaluate(button => {
      button.onclick = () => {
        document.querySelector('#draft').textContent = '';
        document.querySelector('#stop').hidden = false;
        const answer = document.createElement('model-response');
        answer.textContent = 'partial';
        document.body.append(answer);
        setTimeout(() => {answer.textContent = 'partial complete'; document.querySelector('#stop').hidden = true;}, 2_200);
      };
    });
    const baseline = await collectVisibleSnapshots(page, provider.ui.responseSelectors);
    await sendUiPrompt(session, provider, config, 'Generate');
    await page.locator('#draft').fill('Existing user draft');
    await assert.rejects(sendUiPrompt(session, provider, config, 'Do not replace draft'), /ainda está gerando/);
    assert.equal(await page.locator('#draft').innerText(), 'Existing user draft');
    const result = await awaitUiResponse(session, provider, config, baseline, 'Generate');
    assert.equal(result.text, 'partial complete');
    assert.ok(result.durationMs >= 2_000, 'must not finish at the partial answer or time out during generation');
  } finally { await browser.close(); }
});

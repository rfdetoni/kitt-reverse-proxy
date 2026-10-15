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
import { collectVisibleSnapshots, extractArtifactContents, visibleContractBaseline, inspectCompletedAssistantContract, armFreshContractDomObserver, stopFreshContractDomObserver } from '../dist/runtime/ui-dom.js';
import { parseContractJson } from '../dist/util/contract-json.js';
import { readFileSync } from 'node:fs';
import { sendUiPrompt } from '../dist/runtime/ui-interaction.js';
import { awaitUiResponse } from '../dist/runtime/ui-response-monitor.js';
import { UiAutomationError } from '../dist/runtime/ui-errors.js';

test('auto captures one network-only JSON tool action when DOM contains only the prompt', {timeout: 20_000}, async () => {
  const tool = "{\"action\":\"use_tool\",\"tool\":\"kitt_runtime\",\"tool_input\":{\"operation\":\"repo.list\",\"arguments\":{\"path\":\".\"}},\"content\":null,\"reasoning_summary\":\"\",\"loop\":null}";
  const prompt = 'Inspect the current workspace using the available host tools. Example:\n' + tool;
  let posts = 0;
  let receivedPrompt = '';
  const server = createServer(async (request,response) => {
    if (request.method === 'GET') {
      response.writeHead(200,{'content-type':'text/html; charset=utf-8'});
      response.end(`<!doctype html><main id="thread">Earlier context</main>
        <div contenteditable="true" role="textbox" style="min-height:30px"></div>
        <button aria-label="Send message" id="send">Send</button>
        <button aria-label="Stop generating" id="stop" style="display:none">Stop</button>
        <script>
          document.querySelector('#send').onclick = async () => {
            const editor = document.querySelector('[role="textbox"]');
            const prompt = editor.innerText;
            const user = document.createElement('div');
            user.dataset.messageAuthorRole = 'user';
            user.style.whiteSpace = 'pre-wrap';
            user.textContent = prompt;
            document.querySelector('#thread').append(user);
            editor.textContent = '';
            document.querySelector('#stop').style.display = 'block';
            const response = await fetch('/dynamic-stream', {method:'POST',
              headers:{'content-type':'application/json'}, body:JSON.stringify({messages:[{role:'user',content:prompt}]})});
            await response.text();
            document.querySelector('#stop').style.display = 'none';
          };
        </script>`);
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    receivedPrompt = JSON.parse(Buffer.concat(chunks).toString()).messages[0].content;
    posts++;
    response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});
    response.flushHeaders();
    await delay(150);
    const frames = [
      {p:'',o:'add',v:{message:{author:{role:'user'},content:{parts:[tool]}}}},
      {p:'',o:'add',v:{message:{author:{role:'assistant'},content:{parts:['']}}}},
      {p:'/message/content/parts/0',o:'append',v:tool.slice(0,20)},
      {v:tool.slice(20)},
      {p:'/message/metadata/state',o:'replace',v:'finished'}
    ];
    for (const frame of frames) { response.write('data: '+JSON.stringify(frame)+'\n\n'); await delay(30); }
    response.end('data: [DONE]\n\n');
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({headless:true});
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(origin);
    const ui = new UiChatExecutor({page,context,persistent:false},detectProvider('https://chatgpt.com/'),
      {targetUrl:origin,allowedEndpointHosts:[],readMode:'auto',tapMatchTimeoutMs:2000,tapFirstByteMs:2000,
        tapStallMs:2000,tapVerifyTurns:3,uiResponseTimeoutMs:1500,uiSettleMs:50,
        manualInterventionTimeoutMs:2000,headed:false,toolEnforcement:'off'});
    await ui.initialize();
    const result = await ui.execute({messages:[{role:'user',content:prompt}]},{preferRawContract:true});
    assert.equal(result.completion.choices[0].message.content,tool);
    assert.equal(result.metadata.timing.read_source,'tap');
    assert.equal(posts,1,'the accepted request must never be replayed');
    const normalized = text => text.replace(/\s+/g,' ').trim();
    assert.ok(normalized(receivedPrompt).includes(normalized(prompt)));
    assert.equal(normalized(await page.locator('main').innerText()),normalized('Earlier context '+receivedPrompt));
    assert.equal(await page.locator('[data-message-author-role="assistant"]').count(),0);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

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
    const reader = new HybridUiResponseReader({context, page}, {id: 'chatgpt'}, {targetUrl: origin, allowedEndpointHosts: [], readMode: 'tap', uiSettleMs: 50, tapVerifyTurns: 1, tapMatchTimeoutMs: 5_000, tapFirstByteMs: 5_000, tapStallMs: 5_000}, async (...args) => {
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
      const [result] = await Promise.all([reader.read([], prompt, undefined, undefined, index !== 0), fetched]);
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

test('real Chromium selects enabled send controls, requires acceptance and monitors generation', {timeout: 30_000}, async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const session = {context, page};
    const provider = detectProvider('https://gemini.google.com/app');
    const config = {manualInterventionTimeoutMs: 1_000, uiResponseTimeoutMs: 1_000, uiSettleMs: 100, headed: false};
    for (const label of ['Send message', 'Enviar mensagem']) {
      await page.setContent(`<rich-textarea><div id="draft" class="ql-editor" contenteditable="true"></div></rich-textarea>
        <button id="active-send" class="send-button" aria-label="${label}">Send</button>
        <button aria-label="Send message" disabled>Inactive draft</button>
        <button aria-label="Send message" aria-disabled="true">Inactive variant</button>`);
      await page.locator('#active-send').evaluate(button => {
        button.onclick = () => {
          window.sent = document.querySelector('#draft').innerText;
          window.clicks = (window.clicks || 0) + 1;
          document.querySelector('#draft').textContent = '';
        };
      });
      const prompt = 'Current task\nPreserve "quotes" and line breaks.';
      await sendUiPrompt(session, provider, config, prompt);
      assert.equal(await page.evaluate(() => window.sent), prompt);
      assert.equal(await page.evaluate(() => window.clicks), 1);
      await page.evaluate(() => { delete window.sent; delete window.clicks; });
    }
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


test('real Chromium RPC tap learns positional source, retrieves omitted POST data and survives slow composition', {timeout: 30_000}, async () => {
  const expected = JSON.stringify({action:'final_response',tool:null,tool_input:null,content:'    <div>ação 😀</div>\n\nline\nline  ',reasoning_summary:'',loop:null});
  let posts = 0;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, {'content-type':'text/html; charset=utf-8'});
      response.end(`<!doctype html><rich-textarea><div class="ql-editor" contenteditable="true"></div></rich-textarea>
        <button aria-label="Send message" id="send">Send</button><button aria-label="Stop output" id="stop" style="display:none">Stop</button>
        <script>
        document.querySelector('#send').onclick = async () => {
          const editor = document.querySelector('.ql-editor');
          const prompt = editor.innerText;
          editor.innerText = '';
          document.querySelector('#stop').style.display = 'block';
          const node = document.createElement('model-response');
          node.innerHTML = '<message-content style="display:block;white-space:pre-wrap"></message-content>';
          document.body.append(node);
          const response = await fetch('/rpc/stream', {method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
            body:new URLSearchParams({'f.req':JSON.stringify([null,JSON.stringify([[prompt]])])}).toString()});
          await response.text();
          node.firstChild.textContent = document.querySelectorAll('model-response').length === 1 ? ${JSON.stringify(expected)} : 'renderer-damaged-contract';
          document.querySelector('#stop').style.display = 'none';
        };
        </script>`);
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    assert.ok(form.get('f.req').includes('UNIQUE RPC TASK'));
    posts++;
    const envelope = JSON.stringify([['transport','request-id',JSON.stringify([null,[['candidate-id',[expected],'metadata']]])]]);
    const wire = Buffer.from(")]}'\n" + Buffer.byteLength(envelope) + '\n' + envelope + '\n');
    response.writeHead(200, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
    response.flushHeaders();
    await delay(100);
    const split = wire.findIndex(byte => byte >= 0x80) + 1;
    response.write(wire.subarray(0, split));
    await delay(100);
    response.end(wire.subarray(split));
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  let locatorPrototype;
  let originalFill;
  try {
    browser = await chromium.launch({headless:true});
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(origin);
    let bodyReads = 0;
    const wrappedContext = {newCDPSession: async target => {
      const cdp = await context.newCDPSession(target);
      const send = cdp.send.bind(cdp);
      cdp.send = (method, params) => {
        if (method === 'Network.getRequestPostData') bodyReads++;
        // Force Chromium to omit the notification body; the fallback still uses real CDP.
        return send(method, method === 'Network.enable' ? {...params,maxPostDataSize:1} : params);
      };
      return cdp;
    }};
    const provider = detectProvider('https://gemini.google.com/app');
    const ui = new UiChatExecutor({context:wrappedContext,page,persistent:false},provider,
      {targetUrl:origin,allowedEndpointHosts:[],readMode:'tap',tapVerifyTurns:1,tapMatchTimeoutMs:250,tapFirstByteMs:5000,tapStallMs:5000,
        manualInterventionTimeoutMs:1000,uiResponseTimeoutMs:5000,uiSettleMs:100,headed:false,toolEnforcement:'off'});
    await ui.initialize();
    locatorPrototype = Object.getPrototypeOf(page.locator('.ql-editor'));
    originalFill = locatorPrototype.fill;
    locatorPrototype.fill = async function(...args) { await delay(500); return originalFill.apply(this,args); };
    for (let turn = 1; turn <= 2; turn++) {
      const result = await ui.execute({messages:[{role:'user',content:`UNIQUE RPC TASK ${turn}: preserve the source contract.`}]},{preferRawContract:true});
      assert.equal(result.completion.choices[0].message.content,expected);
      assert.equal(ui.describe().read.tap.trusted,true);
      if (turn === 2) assert.equal(await page.locator('model-response message-content').last().innerText(),'renderer-damaged-contract');
    }
    assert.equal(posts,2);
    assert.equal(bodyReads,2);
  } finally {
    if (originalFill) locatorPrototype.fill = originalFill;
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('real Chromium DOM-only JSON recovery works without CDP on ChatGPT and Gemini', {timeout: 30_000}, async () => {
  const browser = await chromium.launch({headless:true});
  const prior = "{\"action\":\"final_response\",\"tool\":null,\"tool_input\":null,\"content\":{\"status\":\"old\"},\"reasoning_summary\":\"\",\"loop\":null}";
  const answer = "{\"action\":\"final_response\",\"tool\":null,\"tool_input\":null,\"content\":{\"status\":\"done\"},\"reasoning_summary\":\"\",\"loop\":null}";
  try {
    for (const [url, markup] of [
      ['https://chatgpt.com/', '<div class="plain-answer"></div>'],
      ['https://gemini.google.com/app', '<model-response><message-content class="reply"></message-content></model-response>']
    ]) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.setContent('<main><div style="white-space:pre-wrap" id="previous"></div></main>');
      await page.locator('#previous').evaluate((node, value) => {node.textContent=value;}, prior);
      const baseline = [{selector:'[pre-submit-visible-text]',frameIndex:-1,count:1,
        text:await visibleContractBaseline(page)}];
      let cdpSessions = 0;
      const session = {page,context:{newCDPSession:async()=>{cdpSessions++;throw Error('CDP disabled');}}};
      const provider = detectProvider(url);
      const reader = new HybridUiResponseReader(session,provider,{
        targetUrl:url,readMode:'auto',uiSettleMs:100,uiResponseTimeoutMs:6_000,
        headed:false,allowedEndpointHosts:[]
      });
      await reader.initialize();
      reader.arm('Different submitted prompt');
      const pending = reader.read(baseline,'Different submitted prompt',undefined,undefined,true);
      await delay(180);
      await page.locator('main').evaluate((node,{markup,text})=>{
        node.insertAdjacentHTML('beforeend',markup);
        const added = node.lastElementChild;
        if (added) {
          added.setAttribute('style','display:block;white-space:pre-wrap');
          const target=added.querySelector('message-content')||added;
          target.textContent=text;
        }
      },{markup,text:answer});
      const probe = await inspectCompletedAssistantContract(page,baseline,'Different submitted prompt');
      assert.equal(probe.text,answer,
        JSON.stringify({url,probe,visible:await page.locator('main').innerText()}));
      const received = await pending;
      assert.equal(received.text,answer);
      assert.equal(received.readDiagnostics.source,'dom');
      assert.equal(received.readDiagnostics.tap_mode,'disabled');
      assert.equal(cdpSessions,1,'auto attempts CDP, then preserves DOM when attachment fails');
      await context.close();
    }
  } finally {await browser.close();}
});


test('real Chromium recovers portal DOM answer outside main with pre-submit replay exclusion', {timeout: 20_000}, async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage();
    await page.setContent('<main><div id="old" style="white-space:pre-wrap"></div></main>');
    const old = "{\"action\":\"final_response\",\"tool\":null,\"tool_input\":null,\"content\":{\"status\":\"previous\"},\"reasoning_summary\":\"\",\"loop\":null}";
    await page.locator('#old').evaluate((node, text) => { node.textContent = text; }, old);
    const baseline = [{selector: '[pre-submit-visible-text]', frameIndex: -1, count: 1,
      text: await visibleContractBaseline(page)}];
    const newReply = "{\"action\":\"final_response\",\"tool\":null,\"tool_input\":null,\"content\":{\"status\":\"new\"},\"reasoning_summary\":\"\",\"loop\":null}";
    await page.evaluate((text) => {
      const node = document.createElement('div');
      node.id = 'portal-reply';
      node.style.whiteSpace = 'pre-wrap';
      node.textContent = text;
      document.body.appendChild(node);
    }, newReply);
    const result = await inspectCompletedAssistantContract(page, baseline, 'A distinct current request');
    assert.equal(result.text, newReply);
    assert.ok(result.freshVisibleChars > 0);
    await browser.close();
  } finally { if (browser.isConnected()) await browser.close(); }
});


test('real Chromium preserves indented JSON from a roleless code block outside main', {timeout: 20_000}, async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage();
    await page.setContent('<main><p>Previous conversation</p></main>');
    const baseline = [{selector: '[pre-submit-visible-text]', frameIndex: -1, count: 1,
      text: await visibleContractBaseline(page)}];
    const reply = "{\"action\":\"final_response\",\"tool\":null,\"tool_input\":null,\"content\":{\"items\":[\"updated\"]},\"reasoning_summary\":\"\",\"loop\":null}";
    await page.evaluate((value) => {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = value;
      pre.appendChild(code);
      document.body.appendChild(pre);
    }, reply);
    const probe = await inspectCompletedAssistantContract(page, baseline, 'New user prompt');
    assert.equal(probe.text, reply);
  } finally { await browser.close(); }
});


test('real Chromium recovers only the fresh JSON answer from DOM mutations without assistant markup', {timeout: 30_000}, async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent('<main id="thread"><div id="old">Earlier context</div></main>');
    const before = await visibleContractBaseline(page);
    const prompt = 'Please create a plan. JSON example: {"items":[{"local_id":"EXAMPLE"}]}';
    const response = "{\"action\":\"final_response\",\"tool\":null,\"tool_input\":null,\"content\":{\"items\":[{\"local_id\":\"T00\",\"kind\":\"task\"},{\"local_id\":\"FINAL\",\"kind\":\"final\"}]},\"reasoning_summary\":\"\",\"loop\":null}";
    const baseline = [{selector:'[pre-submit-visible-text]',frameIndex:-1,count:1,text:before}];
    await armFreshContractDomObserver(page);
    await page.evaluate(prompt => {
      const user = document.createElement('div');
      user.setAttribute('data-message-author-role','user');
      user.textContent = prompt;
      document.querySelector('#thread').append(user);
    },prompt);
    await page.waitForTimeout(25);
    const promptOnly = await inspectCompletedAssistantContract(page, baseline, prompt);
    assert.equal(promptOnly.text,undefined);
    assert.equal(promptOnly.mutationSamples,0);
    await page.evaluate(response => {
      const reply = document.createElement('div');
      reply.textContent = response;
      document.querySelector('#thread').append(reply);
      // Hide the answer from the previous 131k page-text tail fallback;
      // only the post-submit mutation observer can still see its snapshot.
      const filler = document.createElement('div');
      filler.textContent = 'z'.repeat(140_000);
      document.querySelector('#thread').append(filler);
    },response);
    await page.waitForTimeout(25);
    const found = await inspectCompletedAssistantContract(page, baseline, prompt);
    assert.equal(found.assistantNodes,0);
    assert.equal(found.structuralTurnNodes,0);
    assert.equal(found.text,response);
    assert.ok(found.mutationSamples > 0);
    await stopFreshContractDomObserver(page);
    const afterStop = await inspectCompletedAssistantContract(page, baseline, prompt);
    assert.equal(afterStop.mutationSamples,0);
    assert.equal(afterStop.text,undefined);
  } finally { await browser.close(); }
});

test('real Chromium returns a fresh tool action identical to the prompt example', {timeout: 20_000}, async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent('<main><div>Earlier context</div></main>');
    const tool = "{\"action\":\"use_tool\",\"tool\":\"kitt_runtime\",\"tool_input\":{\"operation\":\"repo.list\",\"arguments\":{\"path\":\".\"}},\"content\":null,\"reasoning_summary\":\"\",\"loop\":null}";
    const prompt = 'Inspect the workspace. Example:\n' + tool + '\n' +
      'Use only operations actually listed in the current tool catalog and return one complete action for the host to execute and verify.';
    const baseline = [{selector:'[pre-submit-visible-text]',frameIndex:-1,count:1,text:await visibleContractBaseline(page)}];
    await armFreshContractDomObserver(page);
    await page.evaluate(prompt => {
      const user = document.createElement('div');
      user.setAttribute('data-message-author-role','user');
      user.style.whiteSpace = 'pre-wrap';
      user.textContent = prompt;
      document.querySelector('main').append(user);
    },prompt);
    assert.equal((await inspectCompletedAssistantContract(page,baseline,prompt)).text,undefined);
    await page.evaluate(tool => {
      const reply = document.createElement('div');
      reply.style.whiteSpace = 'pre-wrap';
      reply.textContent = tool;
      document.querySelector('main').append(reply);
    },tool);
    const result = await awaitUiResponse({page,context},detectProvider('https://chatgpt.com/'),
      {headed:false,uiResponseTimeoutMs:5000,uiSettleMs:50},baseline,prompt,undefined,undefined,undefined,true);
    assert.equal(result.text,tool);
    await stopFreshContractDomObserver(page);
  } finally { await browser.close(); }
});

test('real Chromium mutation capture preserves rendered br boundaries outside the page tail', {timeout: 20_000}, async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    await page.setContent('<main>Earlier context</main>');
    const baseline = [{selector:'[pre-submit-visible-text]',frameIndex:-1,count:1,text:await visibleContractBaseline(page)}];
    await armFreshContractDomObserver(page);
    await page.evaluate(() => {
      const reply = document.createElement('div');
      reply.innerHTML = JSON.stringify({action:'use_tool',tool:'kitt_runtime',tool_input:{operation:'repo.list',arguments:{path:'.'}},content:null,reasoning_summary:'',loop:null}).replaceAll(',',',<br>');
      document.querySelector('main').append(reply);
      const filler = document.createElement('div');
      filler.textContent = 'z'.repeat(140000);
      document.querySelector('main').append(filler);
    });
    const result = await inspectCompletedAssistantContract(page,baseline,'Inspect repository');
    assert.equal(result.text,"{\"action\":\"use_tool\",\"tool\":\"kitt_runtime\",\"tool_input\":{\"operation\":\"repo.list\",\"arguments\":{\"path\":\".\"}},\"content\":null,\"reasoning_summary\":\"\",\"loop\":null}");
    await stopFreshContractDomObserver(page);
  } finally { await browser.close(); }
});

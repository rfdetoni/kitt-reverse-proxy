import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSessionBroker } from '../src/runtime/browser-broker.js';
import { SessionManager } from '../src/runtime/session-manager.js';
import type { AppConfig, ChatExecutor, JsonObject, LiveBrowserSession } from '../src/types.js';
import type { ProviderPreset } from '../src/providers/catalog.js';

const config = {
  targetUrl: 'https://chatgpt.com/',
  maxSessions: 4,
  maxBrowserPages: 12,
  maxQueue: 8,
  minIntervalMs: 0,
  sessionIdleTimeoutMs: 600_000,
  manualInterventionTimeoutMs: 2000,
  headed: true
} as AppConfig;

const provider = {
  ui: { newChatUrl: 'https://chatgpt.com/' }
} as ProviderPreset;

test('concurrent retained children receive unique browser tabs in one authenticated context', async () => {
  const pages: Array<{ readonly index: number; url: string | undefined; closed: boolean; goto(url: string): Promise<void>; close(): Promise<void>; isClosed(): boolean }> = [];
  const context = {
    async newPage() {
      const page = {
        index: pages.length,
        url: undefined as string | undefined,
        closed: false,
        async goto(url: string) { this.url = url; },
        async close() { this.closed = true; },
        isClosed() { return this.closed; }
      };
      pages.push(page);
      return page;
    },
    pages: () => pages
  };
  const base = {
    context,
    page: await context.newPage(),
    persistent: true,
    headed: true,
    async close() { /* The default browser page is not owned by a child. */ }
  } as unknown as LiveBrowserSession;
  const broker = new BrowserSessionBroker(base, config);
  const sessions = new Map<string, LiveBrowserSession>();
  let running = 0;
  let peakConcurrent = 0;
  const chatExecutor = (id: string): ChatExecutor => ({
    modelId: id,
    transport: 'ui',
    async execute(_body: JsonObject) {
      peakConcurrent = Math.max(peakConcurrent, ++running);
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      running -= 1;
      return {
        completion: {
          id,
          object: 'chat.completion',
          created: 1,
          model: id,
          choices: [{ index: 0, message: { role: 'assistant', content: id }, finish_reason: 'stop' }]
        },
        deltas: []
      };
    },
    describe() { return {}; }
  });
  const manager = new SessionManager({
    defaultExecutor: chatExecutor('default'),
    defaultBrowserSession: base,
    provider: 'chatgpt',
    config,
    factory: async (id) => {
      const session = await broker.acquire(provider);
      sessions.set(id, session);
      return { executor: chatExecutor(id), browserSession: session };
    }
  });

  try {
    const [first, second] = await Promise.all([
      manager.execute('childa', { messages: [{ role: 'user', content: 'task a' }] }),
      manager.execute('childb', { messages: [{ role: 'user', content: 'task b' }] })
    ]);
    assert.equal(first.completion.choices[0]?.message.content, 'childa');
    assert.equal(second.completion.choices[0]?.message.content, 'childb');
    assert.equal(peakConcurrent, 2, 'sibling session queues must execute concurrently');
    assert.equal(sessions.size, 2);
    assert.notEqual(sessions.get('childa')?.page, sessions.get('childb')?.page);
    assert.notEqual(sessions.get('childa')?.page, base.page);
    assert.notEqual(sessions.get('childb')?.page, base.page);
    assert.equal(sessions.get('childa')?.context, base.context);
    assert.equal(sessions.get('childb')?.context, base.context);
    assert.equal(pages.length, 3, 'one default page and one browser tab per child');
    assert.equal(broker.snapshot().active_leases, 2);
    assert.deepEqual(manager.list().map(({id}) => id), ['default', 'childa', 'childb']);

    const original = sessions.get('childa')?.page;
    const again = await manager.execute('childa', {
      messages: [{ role: 'user', content: 'child a follow-up' }]
    });
    assert.equal(again.completion.choices[0]?.message.content, 'childa');
    assert.equal(sessions.get('childa')?.page, original, 'same retained child reuses its tab');
    assert.equal(pages.length, 3);
  } finally {
    await manager.close();
  }
  assert.equal(broker.snapshot().active_leases, 0);
  assert.deepEqual(pages.map(page => page.closed), [false, true, true]);
});

test('distinct child sessions do not silently collapse onto the default proxy queue', async () => {
  let running = 0;
  let peak = 0;
  const simpleExecutor = (name: string): ChatExecutor => ({
    modelId: name,
    transport: 'ui',
    async execute() {
      peak = Math.max(peak, ++running);
      await new Promise(resolve => setTimeout(resolve, 30));
      running -= 1;
      return { completion: {
        id: name, object: 'chat.completion', created: 1, model: name,
        choices: [{ index: 0, message: { role: 'assistant', content: name }, finish_reason: 'stop' }]
      }, deltas: [] };
    },
    describe() { return {}; }
  });
  const manager = new SessionManager({
    defaultExecutor: simpleExecutor('default'),
    provider: 'chatgpt',
    config,
    factory: async (id) => ({ executor: simpleExecutor(id) })
  });
  try {
    await Promise.all([
      manager.execute('retainedChildA', { messages: [{ role: 'user', content: 'A' }] }),
      manager.execute('retainedChildB', { messages: [{ role: 'user', content: 'B' }] })
    ]);
    assert.equal(peak, 2);
    assert.equal(manager.capacity().named, 2);
  } finally { await manager.close(); }
});


test('first named agent adopts startup tab, child gets another, default is lazy', async () => {
  const pages: Array<{id: number; closed: boolean; goto(url: string): Promise<void>; close(): Promise<void>; isClosed(): boolean}> = [];
  const context = {
    pages: () => pages,
    async newPage() {
      const page = { id: pages.length, closed: false, async goto(_url: string) {},
        async close() { this.closed = true; }, isClosed() { return this.closed; } };
      pages.push(page);
      return page;
    }
  };
  const page = await context.newPage();
  let baseClosed = 0;
  const base = {context, page, persistent: true, headed: true, async close() { baseClosed++; }} as unknown as LiveBrowserSession;
  const broker = new BrowserSessionBroker(base, config);
  const sessions = new Map<string, LiveBrowserSession>();
  const calls: string[] = [];
  const executor = (name: string): ChatExecutor => ({
    modelId: name, transport: 'ui',
    async execute() {
      return {completion:{id:name,object:'chat.completion',created:1,model:name,
        choices:[{index:0,message:{role:'assistant',content:name},finish_reason:'stop'}]},deltas:[]};
    }, describe(){return {};}
  });
  const manager = new SessionManager({
    defaultExecutor: executor('startup'),
    defaultBrowserSession: base,
    provider:'chatgpt',config,
    reuseStartupTabForFirstNamed:true,
    factory:async(id)=>{
      calls.push(id);
      const session = await broker.acquire(provider);
      sessions.set(id,session);
      return {executor:executor(id),browserSession:session};
    }
  });
  try {
    const root = await manager.execute('primaryAgent',{messages:[]});
    assert.equal(root.completion.choices[0]?.message.content,'startup');
    assert.equal(pages.length,1,'bootstrap page should be the first agent tab');
    assert.equal(manager.capacity().browser_pages,1);
    const child = await manager.execute('childAgent',{messages:[]});
    assert.equal(child.completion.choices[0]?.message.content,'childAgent');
    assert.equal(pages.length,2);
    assert.notEqual(sessions.get('childAgent')?.page,page);
    assert.deepEqual(calls,['childAgent']);

    // Default route is deliberately materialized in a *new* page once used.
    const def = await manager.execute(undefined,{messages:[]});
    assert.equal(def.completion.choices[0]?.message.content,'default');
    assert.equal(pages.length,3);
    assert.equal(calls[1],'default');
    assert.notEqual(sessions.get('default')?.page,page);
    assert.equal((await manager.execute('primaryAgent',{messages:[]})).completion.choices[0]?.message.content,'startup');
  } finally {await manager.close();}
  assert.equal(baseClosed,1,'original browser process is closed only by owner shutdown');
  assert.deepEqual(pages.map(x=>x.closed),[true,true,true]);
});

test('default traffic first keeps startup tab and forbids sharing with named sessions', async () => {
  let pages=1;
  const page = { isClosed:()=>false, close:async()=>undefined, goto:async()=>undefined };
  const context = {pages:()=>[page],newPage:async()=>{pages++;return page}};
  const base = {context,page,persistent:true,headed:true,close:async()=>undefined} as unknown as LiveBrowserSession;
  const executor = (id:string):ChatExecutor=>({
    modelId:id,transport:'ui',describe:()=>({}),
    execute:async()=>({completion:{id,object:'chat.completion',created:1,model:id,
      choices:[{index:0,message:{role:'assistant',content:id},finish_reason:'stop'}]},deltas:[]})
  });
  let created=0;
  const manager=new SessionManager({
    provider:'chatgpt',config,defaultExecutor:executor('default'),defaultBrowserSession:base,
    reuseStartupTabForFirstNamed:true,
    factory:async()=>{created++;return {executor:executor('named'),
      browserSession:{...base,close:async()=>undefined}};}
  });
  try{
    await manager.execute(undefined,{messages:[]});
    const result=await manager.execute('agent',{messages:[]});
    assert.equal(result.completion.choices[0]?.message.content,'named');
    assert.equal(created,1,'named session must be separately created after default use');
  }finally{await manager.close();}
});


test('one-page resource ceiling admits first named without starting renderer', async () => {
  let newPages = 0;
  const page = {closed:false,isClosed(){return this.closed;},async close(){this.closed=true;},
    async goto(_url:string){}};
  const context = {pages:()=>[page],async newPage(){newPages++;throw new Error('new tab must not be needed');}};
  const base = {context,page,persistent:true,headed:true,async close(){}} as unknown as LiveBrowserSession;
  const primary:ChatExecutor = {modelId:'startup',transport:'ui',describe:()=>({}),
    async execute(){return {completion:{id:'x',object:'chat.completion',created:0,model:'startup',
      choices:[{index:0,message:{role:'assistant',content:'startup'},finish_reason:'stop'}]},deltas:[]};}};
  const manager = new SessionManager({
    provider:'chatgpt',config:{...config,maxBrowserPages:1},
    defaultExecutor:primary,defaultBrowserSession:base,reuseStartupTabForFirstNamed:true,
    factory:async()=>{throw new Error('factory must not start another browser tab');}
  });
  try{
    const result=await manager.execute('agent',{messages:[]});
    assert.equal(result.completion.choices[0]?.message.content,'startup');
    assert.equal(newPages,0);
    assert.equal(manager.capacity().browser_pages,1);
  }finally{await manager.close();}
});


test('evicted first agent clears chat and reclaims startup page for next named agent', async () => {
  const page = {closed:false,isClosed(){return this.closed;},
    async close(){this.closed=true;},async goto(_url:string){}};
  const context={pages:()=>[page],async newPage(){throw new Error('new tab not expected');}};
  let shutdown=0, resets=0;
  const base={context,page,persistent:true,headed:true,async close(){shutdown++;}} as unknown as LiveBrowserSession;
  const primary:ChatExecutor={
    modelId:'startup',transport:'ui',describe:()=>({}),
    async reset(){resets++;},
    async execute(){return {completion:{id:'x',object:'chat.completion',created:0,model:'startup',
      choices:[{index:0,message:{role:'assistant',content:'ok'},finish_reason:'stop'}]},deltas:[]};}
  };
  const manager=new SessionManager({provider:'chatgpt',config,defaultExecutor:primary,
    defaultBrowserSession:base,reuseStartupTabForFirstNamed:true,
    factory:async()=>{throw new Error('idle primary should reuse startup tab');}});
  try{
    await manager.execute('firstAgent',{messages:[]});
    assert.equal(await manager.delete('firstAgent'),true);
    assert.equal(resets,1,'must reset chat before returning it to the pool');
    assert.equal(page.closed,false,'Chrome must remain available for next agent');
    await manager.execute('nextAgent',{messages:[]});
    assert.equal(manager.capacity().browser_pages,1);
    assert.equal(resets,1);
  }finally{await manager.close();}
  assert.equal(shutdown,1);
  assert.equal(page.closed,true);
});

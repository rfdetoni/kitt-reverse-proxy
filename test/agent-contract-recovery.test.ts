import { kapFromHistoricFixture } from './kap-fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import express from 'express';

import { createOpenAiRouter } from '../src/proxy/openai-router.js';
import type { SessionExecutionLease, SessionManager } from '../src/runtime/session-manager.js';
import type { ChatExecutionOptions, ChatExecutionResult, JsonObject } from '../src/types.js';

function result(content: string): ChatExecutionResult {
  return {
    completion: {
      id: 'contract-repair',
      object: 'chat.completion',
      created: 1,
      model: 'chatgpt-web',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: kapFromHistoricFixture(content) },
        finish_reason: 'stop'
      }]
    },
    deltas: []
  };
}

test('contract repair keeps the same session lease and original task context', async () => {
  const executedBodies: JsonObject[] = [];
  let transactionCalls = 0;
  const lease: SessionExecutionLease = {
    sessionId: 'stable-session',
    contextKey: 'test:stable-session:1',
    generation: 1,
    async execute(body: JsonObject): Promise<ChatExecutionResult> {
      executedBodies.push(body);
      if (executedBodies.length === 1) return result('not valid contract json');
      return result(JSON.stringify({
        action: 'final_response',
        tool: null,
        tool_input: null,
        content: 'recovered',
        reasoning_summary: '',
        loop: null
      }));
    }
  };
  const manager = {
    transport: 'ui',
    modelId: 'chatgpt-web',
    normalizeSessionId(value: string | undefined): string {
      return value || 'default';
    },
    async transaction(
      requestedId: string | undefined,
      _options: ChatExecutionOptions,
      operation: (current: SessionExecutionLease) => Promise<ChatExecutionResult>
    ): Promise<ChatExecutionResult> {
      transactionCalls += 1;
      assert.equal(requestedId, 'stable-session');
      return await operation(lease);
    }
  } as unknown as SessionManager;

  const app = express();
  app.use(express.json());
  app.use(createOpenAiRouter(manager));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-kitt-agent-contract': 'v4',
          'x-kitt-route': 'chat',
          'x-kitt-session-id': 'stable-session'
        },
        body: JSON.stringify({
          model: 'chatgpt-web',
          messages: [{ role: 'user', content: 'keep this task context' }]
        })
      }
    );
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    assert.equal(payload.choices?.[0]?.message?.content, 'recovered');
    assert.equal(transactionCalls, 1);
    assert.equal(executedBodies.length, 2);

    const repairMessages = JSON.stringify(executedBodies[1]?.messages ?? []);
    assert.match(repairMessages, /KITT CONTRACT REPAIR/);
    assert.match(repairMessages, /keep this task context/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

async function executeRecovery(outputs: string[], maxAttempts = 3, tools?: JsonObject[], version = 'v4'): Promise<{ status: number; body: Record<string, unknown>; attempts: number }> {
  let attempts = 0;
  const lease: SessionExecutionLease = {
    sessionId: 'recovery-regression', contextKey: `recovery-${Math.random()}`, generation: 1,
    async execute(body, options) {
      options?.lifecycle?.beforeSubmit(JSON.stringify(body));
      const content = outputs[Math.min(attempts++, outputs.length - 1)]!;
      options?.lifecycle?.received(content);
      return result(content);
    }
  };
  const manager = { transport:'ui', modelId:'chatgpt-web', normalizeSessionId:() => lease.sessionId,
    transaction: async (_id: string, _options: ChatExecutionOptions, operation: (lease: SessionExecutionLease) => Promise<ChatExecutionResult>) => operation(lease)
  } as unknown as SessionManager;
  const app = express(); app.use(express.json()); app.use(createOpenAiRouter(manager));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method:'POST', headers:{'content-type':'application/json','x-kitt-agent-contract':version},
      body:JSON.stringify({messages:[{role:'user',content:'Create x.py'}], kitt_meta:{max_upstream_attempts:maxAttempts},
        tools:tools ?? [{type:'function',function:{name:'write_file',parameters:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content'],additionalProperties:false}}}]})
    });
    return {status:response.status,body:await response.json() as Record<string, unknown>,attempts};
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}
const writeContract = JSON.stringify({action:'use_tool',tool:'write_file',tool_input:{path:'x.py',content:'one\ntwo\n'},content:null,reasoning_summary:'',loop:null});
const falseFinal = JSON.stringify({action:'final_response',tool:null,tool_input:null,content:'File created.',reasoning_summary:'',loop:null});

test('structured results cross the HTTP contract without model-side double serialization', async () => {
  for (const content of [{items:[{title:'Preserve "quotes", tabs\tand newlines\n'}]}, {verdict:'OK',issues:[]}, {verdict:'OK',evidence:['build passed'],issues:[]}]) {
    const candidate = JSON.stringify({action:'final_response',tool:null,tool_input:null,content,reasoning_summary:'',loop:null});
    const recovered = await executeRecovery([candidate], 1);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.attempts, 1);
    const choices = recovered.body.choices as Array<{message:{content:string}}>;
    assert.deepEqual(JSON.parse(choices[0]!.message.content), content);
  }
  const incompatible = await executeRecovery([falseFinal], 1, undefined, 'v2');
  assert.equal(incompatible.status, 400);
  assert.equal(incompatible.attempts, 0);
  assert.equal((incompatible.body.error as {code:string}).code, 'agent_contract_version_mismatch');
});

test('the logged Gemini mirror executes the original action without an upstream repair', async () => {
  const candidate = readFileSync('test/fixtures/gemini-mirrored-contract.txt', 'utf8');
  const recovered = await executeRecovery([candidate], 1, [{type:'function',function:{name:'kitt_runtime',parameters:{type:'object',properties:{operation:{enum:['repo.list']},arguments:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}},required:['operation','arguments'],additionalProperties:false}}}]);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.attempts, 1);
  const choices = recovered.body.choices as Array<{message:{content:string;tool_calls:Array<{function:{name:string;arguments:string}}>}}>;
  assert.equal(choices[0]!.message.tool_calls.length, 1);
  assert.equal(choices[0]!.message.tool_calls[0]!.function.name, 'kitt_runtime');
  assert.deepEqual(JSON.parse(choices[0]!.message.tool_calls[0]!.function.arguments), {operation:'repo.list',arguments:{path:'.'}});
  assert.equal(choices[0]!.message.content, 'Inspeção inicial do diretório de trabalho para verificar estrutura existente.');
});

test('literal multiline KAP write preserves file formatting without upstream repair', async () => {
  const source = 'one\ntwo\n';
  const candidate = [
    'KITT/1','ACTION TOOL','TOOL write_file',
    'STRING path = x.py', 'TEXT content', source, 'KITT/ENDTEXT', 'KITT/END'
  ].join('\n');
  const recovered = await executeRecovery([candidate], 1);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.attempts, 1);
  const choices = recovered.body.choices as Array<{message:{tool_calls:Array<{function:{arguments:string}}>}}>;
  assert.deepEqual(JSON.parse(choices[0]!.message.tool_calls[0]!.function.arguments), {path:'x.py',content:source});
});

test('KAP review text with raw quotes requires no JSON escaping', async () => {
  const content = 'KITT_PLAN_REVIEW: {"verdict":"OK","issues":[]}';
  const recovered = await executeRecovery([[
    'KITT/1', 'ACTION FINAL', 'TEXT content', content, 'KITT/ENDTEXT', 'KITT/END'
  ].join('\n')],1);
  assert.equal(recovered.status,200);
  assert.equal(recovered.attempts,1);
  const choices = recovered.body.choices as Array<{message:{content:string;tool_calls?:unknown}}>;
  assert.equal(choices[0]!.message.content, content);
  assert.equal(choices[0]!.message.tool_calls,undefined);
});

test('contract shape recovery still rejects competing tool arguments', async () => {
  const candidate = '{"action":"use_tool","tool":"write_file","tool_input":{"path":"x.py","content":"print("hello")","mode":"append"},"content":null,"reasoning_summary":"","loop":null}';
  const repaired = JSON.stringify({action:'use_tool',tool:'write_file',tool_input:{path:'x.py',content:'print("hello")',mode:'append'},content:null,reasoning_summary:'',loop:null});
  const failed = await executeRecovery([candidate, repaired], 3, [{type:'function',function:{name:'write_file',parameters:{type:'object',properties:{path:{type:'string'},content:{type:'string'},mode:{type:'string'}},required:['path','content'],additionalProperties:false}}}]);
  assert.equal(failed.status, 409);
  assert.equal(failed.attempts, 1);
  assert.equal(failed.body.choices, undefined);
});

test('conflicting review verdicts cannot be resolved by a model repair at any attempt', async () => {
  const conflicting = '{"action":"final_response","tool":null,"tool_input":null,"content":{"verdict":"OK","verdict":"REJECT","issues":[]},"reasoning_summary":"","loop":null}';
  const approved = JSON.stringify({action:'final_response',tool:null,tool_input:null,content:{verdict:'OK',issues:[]},reasoning_summary:'',loop:null});
  const truncated = '{"action":"final_response","tool":null,"tool_input":null,"content":';
  for (const outputs of [[conflicting, approved], [truncated, conflicting, approved]]) {
    const failed = await executeRecovery(outputs);
    assert.equal(failed.status, 409);
    assert.equal(failed.attempts, outputs.length - 1);
    assert.equal((failed.body.error as {code:string}).code, 'agent_contract_invalid');
    assert.equal(failed.body.choices, undefined);
  }
});

test('a drifting repair cannot replace a pending write with a successful final response', async () => {
  const broken = '{"action":"use_tool","tool":"write_file","tool_input":';
  const failed = await executeRecovery([broken, falseFinal, falseFinal]);
  assert.equal(failed.status, 409); assert.equal(failed.attempts, 3);
  assert.equal((failed.body.error as {recoverable:boolean}).recoverable, true);
  const recovered = await executeRecovery([broken, falseFinal, writeContract]);
  assert.equal(recovered.status, 200);
  assert.match(JSON.stringify(recovered.body), /tool_calls/);
});

test('stalled repairs stop early and respect the same upstream budget', async () => {
  const stalled = await executeRecovery(['broken']);
  assert.equal(stalled.status, 409); assert.equal(stalled.attempts, 2);
  const exhausted = await executeRecovery(['broken'], 1);
  assert.equal(exhausted.status, 409); assert.equal(exhausted.attempts, 1);
  assert.equal((exhausted.body.error as {code:string}).code, 'upstream_budget_exhausted');
});

test('a faithful repair can reveal a second invalid argument within the same bounded recovery', async () => {
  const invalid = writeContract.replace('"path":"x.py"', '"path":1').replace('"content":"one\\ntwo\\n"', '"content":2');
  const partiallyRepaired = invalid.replace('"path":1', '"path":"x.py"');
  const recovered = await executeRecovery([invalid, partiallyRepaired, writeContract]);
  assert.equal(recovered.status, 200); assert.equal(recovered.attempts, 3);
});

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
        message: { role: 'assistant', content },
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
          'x-kitt-agent-contract': 'v2',
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

async function executeRecovery(outputs: string[], maxAttempts = 3, tools?: JsonObject[]): Promise<{ status: number; body: Record<string, unknown>; attempts: number }> {
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
      method:'POST', headers:{'content-type':'application/json','x-kitt-agent-contract':'v2'},
      body:JSON.stringify({messages:[{role:'user',content:'Create x.py'}], kitt_meta:{max_upstream_attempts:maxAttempts},
        tools:tools ?? [{type:'function',function:{name:'write_file',parameters:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content'],additionalProperties:false}}}]})
    });
    return {status:response.status,body:await response.json() as Record<string, unknown>,attempts};
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}
const writeContract = JSON.stringify({action:'use_tool',tool:'write_file',tool_input:{path:'x.py',content:'one\ntwo\n'},content:null,reasoning_summary:'',loop:null});
const falseFinal = JSON.stringify({action:'final_response',tool:null,tool_input:null,content:'File created.',reasoning_summary:'',loop:null});

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

test('local contract syntax repair avoids an upstream retry and preserves file formatting', async () => {
  const recovered = await executeRecovery([writeContract.replace('one\\ntwo\\n','one\ntwo\n')]);
  assert.equal(recovered.status, 200); assert.equal(recovered.attempts, 1);
  const choices = recovered.body.choices as Array<{message:{tool_calls:Array<{function:{arguments:string}}>}}>;
  assert.deepEqual(JSON.parse(choices[0]!.message.tool_calls[0]!.function.arguments), {path:'x.py',content:'one\ntwo\n'});
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

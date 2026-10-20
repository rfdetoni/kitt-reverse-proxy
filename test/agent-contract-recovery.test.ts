import { jsonFromFixture } from './json-fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';

import { buildAgentContractSerializationRepairBody, createOpenAiRouter } from '../src/proxy/openai-router.js';
import { AgentContractValidationError, prepareAgentContractRequest } from '../src/runtime/agent-contract.js';
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
        message: { role: 'assistant', content: jsonFromFixture(content) },
        finish_reason: 'stop'
      }]
    },
    deltas: []
  };
}

test('syntax repair receives a bounded original-task excerpt, not a 60 KiB mission replay', () => {
  const longTask = 'keep this task context ' + 'MISSION-PADDING-'.repeat(5_000);
  const plan = prepareAgentContractRequest({
    messages: [{role:'user', content:longTask}],
    tools:[{type:'function',function:{name:'kitt_runtime',parameters:{type:'object',properties:{operation:{type:'string'}}}}}]
  }, {sessionId:'repair-context-test', contextKey:'repair-context-test'});
  const candidate = '{"action":"use_tool","tool":"kitt_runtime","tool_input":{"operation":"repo.list"';
  const error = new AgentContractValidationError('Incomplete JSON', 'syntax');
  const repaired = buildAgentContractSerializationRepairBody(plan,error,candidate);
  const serialized = JSON.stringify(repaired.messages);
  assert.ok(serialized.length < 8_000, 'repair must not repeat the entire user mission');
  assert.match(serialized, /keep this task context/);
  assert.match(serialized, /task_sha256/);
  assert.match(serialized, /task_truncated/);
  assert.match(serialized, /CONTRACT REPAIR MODE/);
  assert.match(serialized, /repo.list/);
  assert.doesNotMatch(serialized, /MISSION-PADDING-(?:MISSION-PADDING-){100}/);
});

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
          'x-kitt-agent-contract': 'v5',
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

async function executeRecovery(outputs: string[], maxAttempts = 3, tools?: JsonObject[], version = 'v5'): Promise<{ status: number; body: Record<string, unknown>; attempts: number }> {
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

test('agent contract forwards native tools with parallel_tool_calls=false without reparsing', async () => {
  const calls: JsonObject[] = [];
  const client = {
    transport: 'network',
    modelId: 'fixture',
    describe: () => ({ nativeToolCalling: true }),
    execute: async (body: JsonObject) => {
      calls.push(body);
      const completion = result('');
      completion.completion.choices[0]!.message.tool_calls = [{
        id: 'call_native_fixture', type: 'function',
        function: { name: 'kitt_runtime',
          arguments: JSON.stringify({ operation: 'repo.read', arguments: { path: 'README.md' } }) }
      }];
      return completion;
    }
  };
  // A network-capable session is simulated, while validation and HTTP
  // conversion execute through the actual router.
  const manager = {
    transport: 'network', modelId: 'fixture', normalizeSessionId: (id: string | undefined) => id || 'fixture',
    transaction: async (_id: string, _options: unknown, handler: (lease: unknown) => Promise<unknown>) =>
      handler({sessionId:'fixture',contextKey:'fixture',generation:1,nativeToolCalling:true,
        execute: (body: JsonObject) => client.execute(body)}),
  } as any;
  const app = express(); app.use(express.json()); app.use(createOpenAiRouter(manager));
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    const http = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method:'POST', headers:{'content-type':'application/json','x-kitt-agent-contract':'v5'},
      body:JSON.stringify({
        model:'fixture',stream:false,messages:[{role:'user',content:'Read README'}],
        parallel_tool_calls:false,tool_choice:'auto',
        tools:[{type:'function',function:{name:'kitt_runtime',
          parameters:{type:'object',properties:{operation:{type:'string',enum:['repo.read']},
          arguments:{type:'object'}},required:['operation','arguments']}}}]
      })
    });
    assert.equal(http.status, 200);
    const payload = await http.json() as {choices:Array<{message:{tool_calls:Array<{id:string}>}}>};
    assert.equal(payload.choices[0]?.message.tool_calls[0]?.id, 'call_native_fixture');
    assert.equal(calls.length, 1);
    assert.ok(Array.isArray(calls[0]?.tools));
  } finally { server.close(); }
});

test('recovers a model request_tools once without running a host action', async () => {
  const asking = JSON.stringify({
    action:'request_tools',tool:null,tool_input:null,
    content:'List the available host tools',reasoning_summary:'',loop:null
  });
  const final = JSON.stringify({
    action:'final_response',tool:null,tool_input:null,
    content:'Evidence gathered; further inspection blocked',reasoning_summary:'',loop:null
  });
  const result = await executeRecovery([asking, final], 2, [{
    type:'function',function:{name:'kitt_runtime',parameters:{type:'object',
      properties:{operation:{type:'string'},arguments:{type:'object'}},
      required:['operation','arguments']}}
  }]);
  assert.equal(result.status, 200);
  assert.equal(result.attempts, 2);
  assert.match(JSON.stringify(result.body), /further inspection blocked/);
});

test('request_tools with an empty catalog cannot escalate tool authority', async () => {
  const asking = JSON.stringify({
    action:'request_tools',tool:null,tool_input:null,
    content:'Give me host tools',reasoning_summary:'',loop:null
  });
  const result = await executeRecovery([asking], 2, []);
  assert.equal(result.status, 409);
  assert.equal(result.attempts, 1);
  assert.equal((result.body.error as {code:string}).code, 'tools_context_required');
});

test('JSON Gemini action is executed without an upstream JSON repair', async () => {
  const candidate = "{\"action\":\"use_tool\",\"tool\":\"kitt_runtime\",\"tool_input\":{\"operation\":\"repo.list\",\"arguments\":{\"path\":\".\"}},\"content\":null,\"reasoning_summary\":\"Inspeção inicial do diretório de trabalho para verificar estrutura existente.\",\"loop\":null}";
  const recovered = await executeRecovery([candidate], 1, [{
    type:'function',function:{name:'kitt_runtime',parameters:{
      type:'object',properties:{operation:{enum:['repo.list']},arguments:{
        type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false
      }},required:['operation','arguments'],additionalProperties:false
    }}
  }]);
  assert.equal(recovered.status,200);
  assert.equal(recovered.attempts,1);
  const choices = recovered.body.choices as Array<{message:{content:string;tool_calls:Array<{function:{name:string;arguments:string}}>}}>;
  assert.equal(choices[0]!.message.tool_calls[0]!.function.name,'kitt_runtime');
  assert.deepEqual(JSON.parse(choices[0]!.message.tool_calls[0]!.function.arguments),{operation:'repo.list',arguments:{path:'.'}});
  assert.equal(choices[0]!.message.content,'Inspeção inicial do diretório de trabalho para verificar estrutura existente.');
});

test('literal multiline JSON write preserves file formatting without upstream repair', async () => {
  const source = 'one\ntwo\n';
  const candidate = JSON.stringify({action:'use_tool',tool:'write_file',tool_input:{path:'x.py',content:source},content:null,reasoning_summary:'',loop:null});
  const recovered = await executeRecovery([candidate], 1);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.attempts, 1);
  const choices = recovered.body.choices as Array<{message:{tool_calls:Array<{function:{arguments:string}}>}}>;
  assert.deepEqual(JSON.parse(choices[0]!.message.tool_calls[0]!.function.arguments), {path:'x.py',content:source});
});

test('JSON review text with raw quotes requires no JSON escaping', async () => {
  const content = 'KITT_PLAN_REVIEW: {"verdict":"OK","issues":[]}';
  const recovered = await executeRecovery([JSON.stringify({action:'final_response',tool:null,tool_input:null,content,reasoning_summary:'',loop:null})],1);
  assert.equal(recovered.status,200);
  assert.equal(recovered.attempts,1);
  const choices = recovered.body.choices as Array<{message:{content:string;tool_calls?:unknown}}>;
  assert.equal(choices[0]!.message.content, content);
  assert.equal(choices[0]!.message.tool_calls,undefined);
});


test('competing complete JSON drafts are rejected without regeneration', async () => {
  const first = JSON.stringify({action:'final_response',tool:null,tool_input:null,content:{title:'Old draft'},reasoning_summary:'',loop:null});
  const second = first.replace('Old draft','New draft');
  const failed = await executeRecovery([first + '\n' + second, second], 3);
  assert.equal(failed.status,409);
  assert.equal(failed.attempts,1);
  assert.equal(failed.body.choices,undefined);
});

test('duplicate JSON tool arguments are ambiguous and fail without repair', async () => {
  const candidate = '{"action":"use_tool","tool":"write_file","tool_input":{"path":"x.py","path":"malicious.py","content":"hello"},"content":null,"reasoning_summary":"","loop":null}';
  const recovered = await executeRecovery([candidate, writeContract], 3);
  assert.equal(recovered.status,409);
  assert.equal(recovered.attempts,1);
  assert.equal(recovered.body.choices,undefined);
});

test('competing JSON verdicts and actions fail before any repair can select an outcome', async () => {
  const candidates = [
    '{"action":"final_response","tool":null,"tool_input":null,"content":{"verdict":"OK","verdict":"REJECT","issues":[]},"reasoning_summary":"","loop":null}',
    '{"action":"use_tool","action":"final_response","tool":null,"tool_input":null,"content":"incomplete","reasoning_summary":"","loop":null}'
  ];
  const repaired = "{\"action\":\"final_response\",\"tool\":null,\"tool_input\":null,\"content\":{\"verdict\":\"OK\",\"issues\":[]},\"reasoning_summary\":\"\",\"loop\":null}";
  for (const candidate of candidates) {
    const failed = await executeRecovery([candidate, repaired], 3);
    assert.equal(failed.status, 409);
    assert.equal(failed.attempts, 1);
    assert.equal(failed.body.choices, undefined);
  }
});

test('a repair cannot turn a partially written JSON TOOL into a successful final answer', async () => {
  const broken = '{"action":"use_tool","tool":"write_file","tool_input":{"path":"x.py","content":"one';
  const failed = await executeRecovery([broken, falseFinal, falseFinal],3);
  assert.equal(failed.status,409);
  assert.equal((failed.body.error as {recoverable:boolean}).recoverable,true);
  const recovered = await executeRecovery([broken, falseFinal, writeContract],3);
  assert.equal(recovered.status,409);
  assert.equal(recovered.body.choices,undefined);
});

test('stalled repairs stop early and respect the same upstream budget', async () => {
  const echoedWithFence = await executeRecovery(['broken', '```json\nbroken\n```', writeContract], 3);
  assert.equal(echoedWithFence.status, 409);
  assert.equal(echoedWithFence.attempts, 2, 'fenced echo is not progress and must not consume a third attempt');
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

test('bare structured JSON is wrapped locally without another provider turn or host execution', async () => {
  const data = {items:[{local_id:'T01',title:'Inspect the workspace'}]};
  const bare = JSON.stringify(data);
  const wrapped = JSON.stringify({action:'final_response',tool:null,tool_input:null,
    content:data,reasoning_summary:'',loop:null});
  const recovered = await executeRecovery([bare,wrapped],2);
  assert.equal(recovered.status,200);
  assert.equal(recovered.attempts,1);
  const choices = recovered.body.choices as Array<{message:{content:string;tool_calls?:unknown}}>;
  assert.deepEqual(JSON.parse(choices[0]!.message.content),data);
  assert.equal(choices[0]!.message.tool_calls,undefined);
  const rejected = await executeRecovery([bare,writeContract],2);
  assert.equal(rejected.status,200);
  assert.equal(rejected.attempts,1);
  assert.equal((rejected.body.choices as Array<{message:{tool_calls?:unknown}}>)[0]!.message.tool_calls,undefined);
});

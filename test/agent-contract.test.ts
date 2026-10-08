import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_CONTRACT_SYSTEM_PROMPT,
  AgentContractError,
  AgentContractValidationError,
  normalizeAgentContractLogicalHistory,
  prepareAgentContractRequest,
  commitAgentContractContext,
  transformAgentContractCompletion
} from '../src/runtime/agent-contract.js';
import { buildAgentContractRepairBody } from '../src/proxy/openai-router.js';
import type { JsonObject, JsonValue, OpenAiCompletion } from '../src/types.js';

function completion(content: string): OpenAiCompletion {
  return {
    id: 'agent-contract-test',
    object: 'chat.completion',
    created: 1,
    model: 'chatgpt-web',
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop'
    }]
  };
}

function body(
  route = 'chat',
  workspace: JsonValue | 'not_provided' = { files: ['README.md'] },
  discoveryRequired = route === 'code-generation' || route === 'code-edit'
): JsonObject {
  const segments: JsonValue[] = [];
  if (workspace !== 'not_provided') {
    segments.push({
      id: `workspace-${route}`,
      kind: 'REPOSITORY_MAP',
      source: 'repository',
      trust: 'UNTRUSTED_WORKSPACE',
      stability: 'TURN',
      priority: 80,
      sensitivity: 'normal',
      recovery: 'RECOMPUTE',
      cache_region: 'LIVE_ZONE',
      lifecycle: 'turn',
      provenance_digest: 'workspace',
      token_cost: 8,
      body_ref: workspace
    });
  }
  segments.push({
    id: `output-${route}`,
    kind: 'OUTPUT_CONTRACT',
    source: 'run-coordinator',
    trust: 'TRUSTED',
    stability: 'TURN',
    priority: 95,
    sensitivity: 'normal',
    recovery: 'RECOMPUTE',
    cache_region: 'LIVE_ZONE',
    lifecycle: 'turn',
    provenance_digest: 'output',
    token_cost: 4,
    body_ref: {
      loop_action_budget: 4,
      discovery_required: discoveryRequired
    }
  });
  return {
    model: 'chatgpt-web',
    messages: [
      { role: 'user', content: 'Inspect README' }
    ],
    kitt_meta: {
      route,
      conversation_id: 'conversation-test',
      turn_id: 'turn-test',
      request_id: `request-${route}`
    },
    kitt_context: {
      schema_version: 1,
      epoch: `epoch-${route}`,
      segments
    },
    tools: [{
      type: 'function',
      function: {
        name: 'kitt_runtime',
        description: 'Execute KITT runtime operations.',
        parameters: {
          type: 'object',
          properties: {
            operation: {
              type: 'string',
              enum: ['repo.read', 'repo.write_file', 'patch.apply', 'process.run']
            },
            arguments: { type: 'object' }
          },
          required: ['operation', 'arguments'],
          additionalProperties: false
        }
      }
    }]
  };
}

test('replaces upstream system persona and mounts tools/workspace as dynamic turn data', () => {
  const plan = prepareAgentContractRequest(body(), { sessionId: 'sessionA' });
  const messages = plan.body.messages as any[];

  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, AGENT_CONTRACT_SYSTEM_PROMPT);
  assert.match(messages[0].content, /preserve the normal formatting of the language\/project/);
  assert.match(messages[0].content, /Indentation-sensitive languages/);
  assert.match(messages[0].content, /OUTPUT CONTRACT \(mandatory, no exceptions\)/);
  assert.doesNotMatch(messages[0].content, /Você|CONTRATO DE SAÍDA|Regras:|Responda|Retorne/u);
  assert.equal(messages[1].role, 'user');
  assert.match(messages[1].content, /TOOLS_AVAILABLE:/);
  assert.match(messages[1].content, /Execute KITT runtime operations/);
  assert.match(messages[1].content, /UNTRUSTED_WORKSPACE_DATA:/);
  assert.match(messages[1].content, /ORCHESTRATOR_CONTEXT_DATA:/);
  assert.equal(plan.body.tools, undefined);
});

test('keeps model instructions English while preserving user-authored language verbatim', () => {
  const request = body('code-edit', { files: ['backend/build.gradle'] });
  request.messages = [{
    role: 'user',
    content: 'converta o backend deste projeto para maven'
  }];

  const plan = prepareAgentContractRequest(request, { sessionId: 'prompt-language-policy' });
  const messages = plan.body.messages as Array<{ role?: string; content?: string }>;

  assert.equal(messages[0]?.content, AGENT_CONTRACT_SYSTEM_PROMPT);
  assert.match(messages[0]?.content ?? '', /OUTPUT CONTRACT \(mandatory, no exceptions\)/);
  assert.doesNotMatch(messages[0]?.content ?? '', /Você|CONTRATO DE SAÍDA|Regras:|Responda|Retorne/u);
  assert.match(
    messages.find((message) => message.role === 'user')?.content ?? '',
    /converta o backend deste projeto para maven$/
  );
});

test('consumes typed context without dropping the user task', () => {
  const request = body('code-edit', { files: ['src/app.ts'] });
  request.messages = [
    { role: 'system', content: 'Caller system text must not become orchestration state.' },
    { role: 'user', content: 'Fix src/app.ts' }
  ];

  const plan = prepareAgentContractRequest(request, { sessionId: 'cacheFriendlyContext' });
  const messages = plan.body.messages as any[];
  const user = messages.find((message) => message.role === 'user');

  assert.ok(user);
  assert.match(user.content, /\[KITT ORCHESTRATOR TURN DATA\]/);
  assert.match(user.content, /WORKSPACE_CONTEXT:/);
  assert.match(user.content, /Fix src\/app\.ts$/);
  assert.doesNotMatch(user.content, /Caller system text/);
  assert.equal(messages.some((message) => message.role === 'developer'), false);
  assert.equal(plan.route, 'code-edit');
});


test('stable contract sessions switch from bootstrap to compact delta context', () => {
  const sessionId = 'bootstrap-to-delta';
  const first = prepareAgentContractRequest(body('code-generation'), { sessionId });
  const firstUser = (first.body.messages as Array<{ role?: string; content?: string }>)
    .find((message) => message.role === 'user')?.content ?? '';
  assert.match(firstUser, /CONTEXT_MODE: bootstrap/);
  assert.match(firstUser, /TOOLS_AVAILABLE:/);
  assert.match(firstUser, /WORKSPACE_CONTEXT:/);

  commitAgentContractContext(first);
  const second = prepareAgentContractRequest(body('code-generation'), { sessionId });
  const secondUser = (second.body.messages as Array<{ role?: string; content?: string }>)
    .find((message) => message.role === 'user')?.content ?? '';
  assert.match(secondUser, /CONTEXT_MODE: delta/);
  assert.match(secondUser, /TOOLS_AVAILABLE_NAMES:/);
  assert.match(secondUser, /WORKSPACE_CONTEXT: session_cached/);
  assert.match(secondUser, /ORCHESTRATOR_CONTEXT_DATA: session_cached/);
  assert.doesNotMatch(secondUser, /Execute KITT runtime operations/);
});

test('logical history strips typed execution metadata while preserving user messages', () => {
  const first = body('code-generation', { files: ['README.md'], revision: 1 });
  first.messages = [{ role: 'user', content: 'Implement the project' }];

  const second = body('code-generation', { files: ['README.md'], revision: 2 });
  second.messages = [{ role: 'user', content: 'Implement the project' }];

  const firstLogical = normalizeAgentContractLogicalHistory(first);
  const secondLogical = normalizeAgentContractLogicalHistory(second);
  assert.equal((firstLogical.messages as any[])[0]?.content, 'Implement the project');
  assert.equal((secondLogical.messages as any[])[0]?.content, 'Implement the project');
  assert.equal(firstLogical.kitt_context, undefined);
  assert.equal(firstLogical.kitt_meta, undefined);
  assert.equal(secondLogical.kitt_context, undefined);
  assert.equal(secondLogical.kitt_meta, undefined);
});

test('wrapped Agent CLI tool feedback is recovered as a synthetic tool result', () => {
  const firstPlan = prepareAgentContractRequest(
    body('code-edit', { files: ['src/example.ts'] }, false),
    { sessionId: 'wrappedToolFeedback' }
  );
  const firstResult = transformAgentContractCompletion(completion(JSON.stringify({
    action: 'use_tool',
    tool: 'kitt_runtime',
    tool_input: {
      operation: 'repo.write_file',
      arguments: { path: 'src/example.ts', content: 'export const ok = true;' }
    },
    content: null,
    reasoning_summary: 'Vou aplicar a alteração.',
    loop: null
  })), firstPlan);
  const firstMessage = firstResult.choices[0]?.message;
  const toolCall = firstMessage?.tool_calls?.[0];
  assert.ok(toolCall);
  assert.equal(firstMessage?.content, 'Vou aplicar a alteração.');

  const followUp = body('code-edit', { files: ['src/example.ts'] }, false);
  followUp.messages = [
    { role: 'user', content: 'corrija o arquivo do projeto' },
    { role: 'assistant', content: null, tool_calls: [toolCall] },
    {
      role: 'tool',
      tool_call_id: toolCall.id,
      name: 'kitt_runtime',
      content: 'write completed'
    }
  ] as any[];

  const secondPlan = prepareAgentContractRequest(followUp, { sessionId: 'wrappedToolFeedback' });
  const messages = secondPlan.body.messages as any[];
  const resultMessage = messages.find((message) =>
    message.role === 'user'
    && typeof message.content === 'string'
    && message.content.includes('[KITT TOOL RESULT DATA]')
  );
  assert.ok(resultMessage);
  assert.match(resultMessage.content, /write completed/);
  assert.match(resultMessage.content, new RegExp(`CALL_ID: ${toolCall.id}`));
});

test('converts a valid use_tool contract into a native OpenAI tool call', () => {
  const plan = prepareAgentContractRequest(body(), { sessionId: 'sessionB' });
  const result = transformAgentContractCompletion(completion(JSON.stringify({
    action: 'use_tool',
    tool: 'kitt_runtime',
    tool_input: { operation: 'repo.read', arguments: { path: 'README.md' } },
    content: null,
    reasoning_summary: 'Preciso ler o arquivo solicitado.',
    loop: null
  })), plan);

  const message = result.choices[0]?.message;
  assert.equal(message?.content, 'Preciso ler o arquivo solicitado.');
  assert.equal(message?.tool_calls?.[0]?.function.name, 'kitt_runtime');
  assert.deepEqual(JSON.parse(message?.tool_calls?.[0]?.function.arguments || '{}'), {
    operation: 'repo.read',
    arguments: { path: 'README.md' }
  });
  assert.equal(result.choices[0]?.finish_reason, 'tool_calls');
});

test('normalizes synthesized native tool continuity before the UI executor', () => {
  const firstPlan = prepareAgentContractRequest(body(), { sessionId: 'sessionToolContinuity' });
  const firstResult = transformAgentContractCompletion(completion(JSON.stringify({
    action: 'use_tool',
    tool: 'kitt_runtime',
    tool_input: { operation: 'repo.read', arguments: { path: 'README.md' } },
    content: null,
    reasoning_summary: 'Vou ler o arquivo antes de continuar.',
    loop: null
  })), firstPlan);

  const toolCall = firstResult.choices[0]?.message.tool_calls?.[0];
  assert.ok(toolCall);

  const followUp = body();
  followUp.messages = [
    ...(followUp.messages as any[]),
    {
      role: 'assistant',
      content: firstResult.choices[0]?.message.content,
      tool_calls: [toolCall]
    },
    {
      role: 'developer',
      content: '[KITT ACTION CONSTRAINTS] keep using the supplied runtime'
    },
    {
      role: 'tool',
      tool_call_id: toolCall.id,
      name: 'kitt_runtime',
      content: 'README contents from the host.'
    }
  ];

  const secondPlan = prepareAgentContractRequest(followUp, { sessionId: 'sessionToolContinuity' });
  const messages = secondPlan.body.messages as any[];

  assert.equal(messages.some((message) => message.role === 'tool'), false);
  assert.equal(messages.some((message) => message.role === 'assistant' && Array.isArray(message.tool_calls)), false);
  assert.equal(messages.some((message) => message.role === 'assistant' && message.content === 'Vou ler o arquivo antes de continuar.'), false);

  const resultMessage = messages.find((message) =>
    message.role === 'user' && typeof message.content === 'string' && message.content.includes('[KITT TOOL RESULT DATA]')
  );
  assert.ok(resultMessage);
  assert.match(resultMessage.content, /TOOL: kitt_runtime/);
  assert.match(resultMessage.content, new RegExp(`CALL_ID: ${toolCall.id}`));
  assert.match(resultMessage.content, /UNTRUSTED_TOOL_RESULT_DATA:/);
  assert.match(resultMessage.content, /README contents from the host/);
});

test('rejects oversized reasoning while wrapped JSON normalization is covered separately', () => {
  const plan = prepareAgentContractRequest(body(), { sessionId: 'sessionC' });
  assert.throws(
    () => transformAgentContractCompletion(completion(JSON.stringify({
      action: 'final_response',
      tool: null,
      tool_input: null,
      content: 'ok',
      reasoning_summary: 'x'.repeat(401),
      loop: null
    })), plan),
    AgentContractValidationError
  );
});

test('accepts deterministic WebChat JSON wrappers without extracting JSON from prose', () => {
  const plan = prepareAgentContractRequest(body(), { sessionId: 'webchat-wrapper-tolerance' });
  const canonical = JSON.stringify({
    action: 'use_tool',
    tool: 'kitt_runtime',
    tool_input: { operation: 'repo.read', arguments: { path: 'README.md' } },
    content: null,
    reasoning_summary: 'Vou ler o arquivo.',
    loop: null
  });

  for (const candidate of [
    `JSON\n${canonical}`,
    `\`\`\`json\n${canonical}\n\`\`\``,
    `\`\`\`\n${canonical}\n\`\`\``
  ]) {
    const result = transformAgentContractCompletion(completion(candidate), plan);
    assert.equal(result.choices[0]?.message.tool_calls?.[0]?.function.name, 'kitt_runtime');
  }

  assert.throws(
    () => transformAgentContractCompletion(completion(`Here is the JSON:\n${canonical}`), plan),
    AgentContractValidationError
  );
});

test('contract repair retains the user task without replaying typed context', () => {
  const request = body('agent-loop', {
    files: ['README.md'],
    marker: 'CONTEXT_MUST_NOT_BE_REPLAYED'
  });
  request.messages = [{ role: 'user', content: 'ORIGINAL_TASK_MUST_NOT_BE_REPLAYED' }];
  const plan = prepareAgentContractRequest(request, { sessionId: 'compact-contract-repair' });
  const candidate = 'JSON\\n{invalid candidate}';

  const repaired = buildAgentContractRepairBody(
    plan,
    new AgentContractValidationError('The model response is not a pure JSON object.'),
    candidate
  );
  const serialized = JSON.stringify(repaired.messages);

  assert.match(serialized, /agent-loop/);
  assert.match(serialized, /kitt_runtime/);
  assert.match(serialized, /invalid candidate/);
  assert.match(serialized, /ORIGINAL_TASK_MUST_NOT_BE_REPLAYED/);
  assert.doesNotMatch(serialized, /CONTEXT_MUST_NOT_BE_REPLAYED/);
});

test('accepts only the canonical contract shape after provider extraction', () => {
  const plan = prepareAgentContractRequest(body(), { sessionId: 'canonical-only' });
  const canonical = {
    action: 'use_tool',
    tool: 'kitt_runtime',
    tool_input: { operation: 'repo.read', arguments: { path: 'README.md' } },
    content: null,
    reasoning_summary: 'Vou ler o arquivo.',
    loop: null
  };

  const fenced = transformAgentContractCompletion(
    completion(`\`\`\`json\n${JSON.stringify(canonical)}\n\`\`\``),
    plan
  );
  assert.equal(fenced.choices[0]?.message.tool_calls?.[0]?.function.name, 'kitt_runtime');

  const legacyDialects = [
    JSON.stringify({ ...canonical, action: ['use_tool'] }),
    JSON.stringify({ ...canonical, loop: { objective: 'Review', completion_criteria: ['Verify'], status: ['complete'], validation_summary: '' } }),
    JSON.stringify({ operation: 'repo.read', arguments: { path: 'README.md' } }),
    '<kitt-tool>{"name":"kitt_runtime","arguments":{"operation":"repo.read","arguments":{"path":"README.md"}}}</kitt-tool>',
    JSON.stringify({
      action: 'use_tool',
      tool_name: 'kitt_runtime',
      arguments: { operation: 'repo.read', arguments: { path: 'README.md' } },
      content: null,
      reasoning_summary: '',
      loop: null
    }),
    JSON.stringify({
      action: 'final_response',
      tool: null,
      tool_input: null,
      content: 'ok',
      reasoning_summary: ''
    })
  ];

  for (const candidate of legacyDialects) {
    assert.throws(
      () => transformAgentContractCompletion(completion(candidate), plan),
      AgentContractValidationError
    );
  }
});

test('caller route remains structural metadata and does not rewrite the host tool surface', () => {
  const request = body('validate-diff');
  request.messages = [
    ...(request.messages as any[]).slice(0, 2),
    {
      role: 'user',
      content: 'Intent: IMPLEMENT\n\nGoal:\nCreate backend and frontend for the requested project.'
    }
  ];

  const plan = prepareAgentContractRequest(request, {
    sessionId: 'sessionRouteMetadata',
    route: 'validate-diff'
  });
  const dynamic = String(
    (plan.body.messages as any[]).find(
      (message) => typeof message.content === 'string'
        && message.content.includes('[KITT ORCHESTRATOR TURN DATA]')
    )?.content || ''
  );

  assert.equal(plan.route, 'validate-diff');
  assert.match(dynamic, /repo\.write_file/);
  assert.match(dynamic, /patch\.apply/);
});

test('workspace conversion wording does not strengthen chat route', () => {
  const request = body('chat');
  request.messages = [
    ...(request.messages as any[]).slice(0, 2),
    { role: 'user', content: 'converta o backend deste projeto para maven' }
  ];

  const plan = prepareAgentContractRequest(request, {
    sessionId: 'sessionStrengthenedConversion',
    route: 'chat'
  });

  assert.equal(plan.route, 'chat');
});

test('explicit edit wording does not strengthen validate-diff route', () => {
  const request = body('validate-diff');
  request.messages = [
    ...(request.messages as any[]).slice(0, 2),
    { role: 'user', content: 'corrija o backend do projeto e depois rode os testes' }
  ];

  const plan = prepareAgentContractRequest(request, {
    sessionId: 'sessionStrengthenedEdit',
    route: 'validate-diff'
  });

  assert.equal(plan.route, 'validate-diff');
});

test('pure validation request remains validate-diff', () => {
  const request = body('validate-diff');
  request.messages = [
    ...(request.messages as any[]).slice(0, 2),
    { role: 'user', content: 'rode os testes e valide o diff' }
  ];

  const plan = prepareAgentContractRequest(request, {
    sessionId: 'sessionPureValidation',
    route: 'validate-diff'
  });

  assert.equal(plan.route, 'validate-diff');
});

test('proxy preserves caller-provided tools and leaves execution policy to the host', () => {
  const plan = prepareAgentContractRequest(body('validate-diff'), { sessionId: 'sessionHostPolicy' });
  const messages = plan.body.messages as any[];
  const dynamic = String(
    messages.find(
      (message) => typeof message.content === 'string'
        && message.content.includes('[KITT ORCHESTRATOR TURN DATA]')
    )?.content || ''
  );

  assert.match(dynamic, /repo\.read/);
  assert.match(dynamic, /repo\.write_file/);
  assert.match(dynamic, /patch\.apply/);
  assert.match(dynamic, /process\.run/);

  const result = transformAgentContractCompletion(completion(JSON.stringify({
    action: 'use_tool',
    tool: 'kitt_runtime',
    tool_input: { operation: 'patch.apply', arguments: { patch: '...' } },
    content: null,
    reasoning_summary: 'Encaminhando a ação estrutural para o host.',
    loop: null
  })), plan);
  assert.equal(result.choices[0]?.message.tool_calls?.[0]?.function.name, 'kitt_runtime');

  const summarize = prepareAgentContractRequest(body('summarize'), { sessionId: 'summaryHostPolicy' });
  assert.equal(summarize.tools.size, 1);
});

test('returns a structured orchestration error when workspace is explicitly requested', () => {
  const plan = prepareAgentContractRequest(body('chat', 'not_provided'), { sessionId: 'sessionE' });
  assert.throws(
    () => transformAgentContractCompletion(completion(JSON.stringify({
      action: 'request_workspace',
      tool: null,
      tool_input: null,
      content: 'Preciso do workspace atual.',
      reasoning_summary: 'O workspace não foi fornecido.',
      loop: null
    })), plan),
    (error: unknown) => error instanceof AgentContractError && error.code === 'workspace_context_required' && error.status === 409
  );
});


test('validate-diff never exposes a malformed contract attempt as final text', () => {
  const plan = prepareAgentContractRequest(body('validate-diff'), { sessionId: 'sessionRepairRescue' });
  const malformed = '```json\n{"action":"final_response","tool":null,"tool_input":null,"content":"tests ok"\n```';

  assert.throws(
    () => transformAgentContractCompletion(completion(malformed), plan),
    AgentContractValidationError
  );
});

test('mutation route keeps rejecting plain text after a mutation round trip', () => {
  const followUp = body('code-edit');
  followUp.messages = [
    ...(followUp.messages as any[]),
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_mutation',
        type: 'function',
        function: {
          name: 'kitt_runtime',
          arguments: JSON.stringify({
            operation: 'repo.write_file',
            arguments: { path: 'src/example.ts', content: 'export const ok = true;' }
          })
        }
      }]
    },
    {
      role: 'tool',
      tool_call_id: 'call_mutation',
      name: 'kitt_runtime',
      content: 'write completed'
    }
  ];

  const plan = prepareAgentContractRequest(followUp, { sessionId: 'sessionMutationTextFallback' });

  assert.throws(
    () => transformAgentContractCompletion(
      completion('Alteração aplicada e validada.'),
      plan
    ),
    AgentContractValidationError
  );
});


test('direct chat keeps canonical request actions without proxy-side policy', () => {
  const request: JsonObject = {
    model: 'gemini-web',
    messages: [{ role: 'user', content: 'Explain dependency injection briefly.' }]
  };
  const plan = prepareAgentContractRequest(request, {
    sessionId: 'direct-chat-no-context',
    route: 'chat'
  });
  const messages = plan.body.messages as Array<{ role?: string; content?: string }>;
  const user = messages.find((message) => message.role === 'user')?.content ?? '';

  assert.equal(plan.route, 'chat');
  assert.equal(plan.tools.size, 0);
  assert.match(user, /TOOLS_AVAILABLE: \[\]/);

  assert.throws(
    () => transformAgentContractCompletion(completion(JSON.stringify({
      action: 'request_tools',
      tool: null,
      tool_input: null,
      content: 'I need tools.',
      reasoning_summary: 'Requesting tools.',
      loop: null
    })), plan),
    (error: unknown) => error instanceof AgentContractError
      && error.code === 'tools_context_required'
      && error.status === 409
  );

  const result = transformAgentContractCompletion(completion(JSON.stringify({
    action: 'final_response',
    tool: null,
    tool_input: null,
    content: 'Dependency injection supplies dependencies from outside an object.',
    reasoning_summary: '',
    loop: null
  })), plan);
  assert.match(result.choices[0]?.message.content ?? '', /supplies dependencies/);
});


test('typed context envelope is lowered without textual rediscovery', () => {
  const source = body('agent-loop', 'not_provided');
  source.messages = [{ role: 'user', content: 'Corrija o projeto sem reescrever minha intenção.' }];
  source.kitt_context = {
    schema_version: 1,
    epoch: 'conversation-1:turn-1',
    segments: [
      {
        id: 'intent', kind: 'USER_INTENT', source: 'user', trust: 'TRUSTED',
        stability: 'TURN', priority: 100, sensitivity: 'private', recovery: 'NONE',
        cache_region: 'LIVE_ZONE', lifecycle: 'turn', provenance_digest: 'a', token_cost: 5,
        body_ref: { text: 'Corrija o projeto sem reescrever minha intenção.' }
      },
      {
        id: 'memory', kind: 'MEMORY_RECALL', source: 'kitt-memoryd', trust: 'TRUSTED',
        stability: 'SESSION', priority: 94, sensitivity: 'private', recovery: 'SOURCE_REF',
        cache_region: 'SESSION_PREFIX', lifecycle: 'session', provenance_digest: 'b', token_cost: 4,
        body_ref: { text: 'decision from durable memory' }
      },
      {
        id: 'repo', kind: 'REPOSITORY_MAP', source: 'repository', trust: 'UNTRUSTED_WORKSPACE',
        stability: 'TURN', priority: 76, sensitivity: 'normal', recovery: 'RECOMPUTE',
        cache_region: 'LIVE_ZONE', lifecycle: 'turn', provenance_digest: 'c', token_cost: 4,
        body_ref: { text: 'src/app.ts' }
      },
      {
        id: 'output', kind: 'OUTPUT_CONTRACT', source: 'run-coordinator', trust: 'TRUSTED',
        stability: 'TURN', priority: 97, sensitivity: 'normal', recovery: 'RECOMPUTE',
        cache_region: 'LIVE_ZONE', lifecycle: 'turn', provenance_digest: 'd', token_cost: 2,
        body_ref: { loop_action_budget: 7, discovery_required: true }
      }
    ]
  };

  const plan = prepareAgentContractRequest(source, {
    sessionId: 'typed-context',
    route: 'agent-loop'
  });
  const userMessage = (plan.body.messages as any[]).find((message) => message.role === 'user');
  const lowered = String(userMessage?.content ?? '');
  assert.match(lowered, /decision from durable memory/);
  assert.match(lowered, /src\/app\.ts/);
  assert.match(lowered, /loop_action_budget/);
  assert.match(lowered, /discovery_required/);
  assert.doesNotMatch(lowered, /\[KITT TURN CONTEXT\]/);
  assert.equal(lowered.split('Corrija o projeto sem reescrever minha intenção.').length - 1, 1);
});


test('rejects unsupported structural routes instead of coercing them to chat', () => {
  const request = body('chat');
  assert.throws(
    () => prepareAgentContractRequest(request, {
      sessionId: 'metadata-route',
      route: 'future-route'
    }),
    (error: unknown) => error instanceof AgentContractError
      && error.code === 'agent_contract_metadata_invalid'
      && /Unsupported KITT agent route/.test(error.message)
  );
});

test('rejects unknown and mismatched request metadata', () => {
  const unknown = body('chat');
  unknown.kitt_meta = {
    ...(unknown.kitt_meta as Record<string, unknown>),
    unexpected: 'hidden-channel'
  };
  assert.throws(
    () => prepareAgentContractRequest(unknown, {
      sessionId: 'metadata-session',
      route: 'chat'
    }),
    /unknown kitt_meta field/
  );

  const mismatch = body('chat');
  mismatch.kitt_meta = {
    ...(mismatch.kitt_meta as Record<string, unknown>),
    session_id: 'session-a'
  };
  assert.throws(
    () => prepareAgentContractRequest(mismatch, {
      sessionId: 'session-b',
      route: 'chat'
    }),
    /session_id does not match/
  );
});

test('schema repair preserves valid sibling arguments while correcting only the reported path', async () => {
  const { assertAgentRepairContinuity } = await import('../src/runtime/agent-contract.js');
  const candidate = JSON.stringify({action:'use_tool',tool:'read_file',tool_input:{path:'safe.txt',limit:'bad'},content:null,reasoning_summary:'',loop:null});
  const error = new AgentContractValidationError('Invalid limit', 'schema', ['$/tool_input/limit']);
  assert.doesNotThrow(() => assertAgentRepairContinuity(candidate, candidate.replace('"bad"','2'), error));
  assert.throws(() => assertAgentRepairContinuity(candidate, candidate.replace('"bad"','2').replace('safe.txt','other.txt'), error), /unaffected candidate data/);
});

test('a truncated tool input still anchors complete nested arguments during model repair', async () => {
  const { assertAgentRepairContinuity } = await import('../src/runtime/agent-contract.js');
  const candidate = '{"action":"use_tool","tool":"write_file","tool_input":{"path":"safe.txt","content":"cut';
  const repaired = JSON.stringify({action:'use_tool',tool:'write_file',tool_input:{path:'safe.txt',content:'cut'},content:null,reasoning_summary:'',loop:null});
  const error = new AgentContractValidationError('Incomplete input', 'syntax');
  assert.doesNotThrow(() => assertAgentRepairContinuity(candidate, repaired, error));
  assert.throws(() => assertAgentRepairContinuity(candidate, repaired.replace('safe.txt','other.txt'), error), /unaffected candidate data/);
});

test('a known path before ambiguous content remains anchored when its parent has competing parses', async () => {
  const { assertAgentRepairContinuity } = await import('../src/runtime/agent-contract.js');
  const candidate = '{"action":"use_tool","tool":"write_file","tool_input":{"path":"safe.py","content":"print("hello")","mode":"append"},"content":null,"reasoning_summary":"","loop":null}';
  const repaired = JSON.stringify({action:'use_tool',tool:'write_file',tool_input:{path:'safe.py',content:'print("hello")',mode:'append'},content:null,reasoning_summary:'',loop:null});
  const error = new AgentContractValidationError('Ambiguous content', 'ambiguous');
  assert.doesNotThrow(() => assertAgentRepairContinuity(candidate, repaired, error));
  assert.throws(() => assertAgentRepairContinuity(candidate, repaired.replace('safe.py','other.py'), error), /unaffected candidate data/);
});


test('agent contract bounds serialized UTF-8 tool arguments before returning a call', () => {
  const plan = prepareAgentContractRequest(body(), { sessionId: 'argument-limit' });
  const input = (content: string) => ({ operation: 'repo.write_file', arguments: { path: 'safe.txt', content } });
  const response = (tool_input: JsonObject) => completion(JSON.stringify({
    action: 'use_tool', tool: 'kitt_runtime', tool_input, content: null, reasoning_summary: '', loop: null
  }));
  const overhead = Buffer.byteLength(JSON.stringify(input('')), 'utf8');
  const accepted = input('x'.repeat(65536 - overhead));
  assert.equal(transformAgentContractCompletion(response(accepted), plan).choices[0]?.finish_reason, 'tool_calls');
  assert.throws(() => transformAgentContractCompletion(response(input('x'.repeat(65537 - overhead))), plan), /64 KiB/);
  assert.throws(() => transformAgentContractCompletion(response(input('á'.repeat(32768))), plan), /64 KiB/);
});

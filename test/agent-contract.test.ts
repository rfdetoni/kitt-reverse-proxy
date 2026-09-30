import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_CONTRACT_SYSTEM_PROMPT,
  AgentContractError,
  AgentContractValidationError,
  normalizeAgentContractLogicalHistory,
  prepareAgentContractRequest,
  transformAgentContractCompletion
} from '../src/runtime/agent-contract.js';
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

function body(route = 'chat', workspace: JsonValue = { files: ['README.md'] }): JsonObject {
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
      segments: [
        {
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
        },
        {
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
            discovery_required: route === 'code-generation' || route === 'code-edit'
          }
        }
      ]
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
  assert.equal(plan.workspaceProvided, true);
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
  const firstPlan = prepareAgentContractRequest(body('code-edit'), { sessionId: 'wrappedToolFeedback' });
  const firstResult = transformAgentContractCompletion(completion(JSON.stringify({
    action: 'use_tool',
    tool: 'kitt_runtime',
    tool_input: {
      operation: 'repo.write_file',
      arguments: { path: 'src/example.ts', content: 'export const ok = true;' }
    },
    content: null,
    reasoning_summary: 'Vou aplicar a alteração.'
  })), firstPlan);
  const firstMessage = firstResult.choices[0]?.message;
  const toolCall = firstMessage?.tool_calls?.[0];
  assert.ok(toolCall);
  assert.equal(firstMessage?.content, 'Vou aplicar a alteração.');

  const followUp = body('code-edit');
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
  assert.equal(secondPlan.mutationRoundTripObserved, true);
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
    reasoning_summary: 'Preciso ler o arquivo solicitado.'
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
    reasoning_summary: 'Vou ler o arquivo antes de continuar.'
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
      reasoning_summary: 'x'.repeat(401)
    })), plan),
    AgentContractValidationError
  );
});

test('caller route is authoritative regardless of mutation-like prompt wording', () => {
  const request = body('validate-diff');
  request.messages = [
    ...(request.messages as any[]).slice(0, 2),
    {
      role: 'user',
      content: 'Intent: IMPLEMENT\n\nGoal:\nCreate backend and frontend for the requested project.'
    }
  ];

  const plan = prepareAgentContractRequest(request, {
    sessionId: 'sessionStrengthenedImplement',
    route: 'validate-diff'
  });
  const developer = String((plan.body.messages as any[])[1]?.content || '');

  assert.equal(plan.route, 'validate-diff');
  assert.match(developer, /ROUTE: validate-diff/);
  assert.doesNotMatch(developer, /repo\.write_file/);
  assert.doesNotMatch(developer, /patch\.apply/);
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
  assert.equal(plan.mutationToolAvailable, true);
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

test('validate-diff advertises only route-allowed runtime operations', () => {
  const plan = prepareAgentContractRequest(body('validate-diff'), { sessionId: 'sessionScopedTools' });
  const messages = plan.body.messages as any[];
  const developer = String(messages[1]?.content || '');

  assert.match(developer, /repo\.read/);
  assert.match(developer, /process\.run/);
  assert.doesNotMatch(developer, /repo\.write_file/);
  assert.doesNotMatch(developer, /patch\.apply/);
});

test('context-gather does not advertise mutating runtime operations', () => {
  const plan = prepareAgentContractRequest(body('context-gather'), { sessionId: 'sessionReadOnlyTools' });
  const messages = plan.body.messages as any[];
  const developer = String(messages[1]?.content || '');

  assert.match(developer, /repo\.read/);
  assert.doesNotMatch(developer, /repo\.write_file/);
  assert.doesNotMatch(developer, /patch\.apply/);
  assert.doesNotMatch(developer, /process\.run/);
});

test('validate-diff rejects file mutation but permits validation command execution', () => {
  const plan = prepareAgentContractRequest(body('validate-diff'), { sessionId: 'sessionD' });
  assert.throws(
    () => transformAgentContractCompletion(completion(JSON.stringify({
      action: 'use_tool',
      tool: 'kitt_runtime',
      tool_input: { operation: 'patch.apply', arguments: { patch: '...' } },
      content: null,
      reasoning_summary: 'A alteração seria aplicada.'
    })), plan),
    AgentContractValidationError
  );

  const result = transformAgentContractCompletion(completion(JSON.stringify({
    action: 'use_tool',
    tool: 'kitt_runtime',
    tool_input: { operation: 'process.run', arguments: { command: 'npm test' } },
    content: null,
    reasoning_summary: 'Vou executar a validação solicitada.'
  })), plan);
  assert.equal(result.choices[0]?.message.tool_calls?.[0]?.function.name, 'kitt_runtime');
});

test('summarize never exposes a generic workspace runtime tool', () => {
  const plan = prepareAgentContractRequest(body('summarize'), { sessionId: 'summarySession' });

  assert.equal(plan.tools.size, 0);
  assert.throws(
    () => transformAgentContractCompletion(completion(JSON.stringify({
      action: 'use_tool',
      tool: 'kitt_runtime',
      tool_input: { operation: 'repo.create_directory', arguments: { path: 'backend' } },
      content: null,
      reasoning_summary: 'Não devo executar workspace durante resumo.'
    })), plan),
    AgentContractValidationError
  );
});

test('returns a structured orchestration error when workspace is explicitly requested', () => {
  const plan = prepareAgentContractRequest(body('chat', 'not_provided'), { sessionId: 'sessionE' });
  assert.throws(
    () => transformAgentContractCompletion(completion(JSON.stringify({
      action: 'request_workspace',
      tool: null,
      tool_input: null,
      content: 'Preciso do workspace atual.',
      reasoning_summary: 'O workspace não foi fornecido.'
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
  assert.equal(plan.mutationRoundTripObserved, true);

  assert.throws(
    () => transformAgentContractCompletion(
      completion('Alteração aplicada e validada.'),
      plan
    ),
    AgentContractValidationError
  );
});


test('direct chat without external context resolves through final_response instead of requesting tools', () => {
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
  assert.equal(plan.workspaceProvided, false);
  assert.match(user, /direct chat turn with no external execution context/i);
  assert.match(user, /TOOLS_AVAILABLE=\[\]/);

  assert.throws(
    () => transformAgentContractCompletion(completion(JSON.stringify({
      action: 'request_tools',
      tool: null,
      tool_input: null,
      content: 'I need tools.',
      reasoning_summary: 'Requesting tools.'
    })), plan),
    (error: unknown) => error instanceof AgentContractValidationError
      && /Direct chat without external execution context/.test(error.message)
  );

  const result = transformAgentContractCompletion(completion(JSON.stringify({
    action: 'final_response',
    tool: null,
    tool_input: null,
    content: 'Dependency injection supplies dependencies from outside an object.',
    reasoning_summary: ''
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
  assert.equal(plan.loopActionBudget, 7);
  assert.equal(plan.discoveryRequired, true);
  assert.equal(plan.workspaceProvided, true);
  const userMessage = (plan.body.messages as any[]).find((message) => message.role === 'user');
  const lowered = String(userMessage?.content ?? '');
  assert.match(lowered, /decision from durable memory/);
  assert.match(lowered, /src\/app\.ts/);
  assert.doesNotMatch(lowered, /\[KITT TURN CONTEXT\]/);
  assert.equal(lowered.split('Corrija o projeto sem reescrever minha intenção.').length - 1, 1);
});

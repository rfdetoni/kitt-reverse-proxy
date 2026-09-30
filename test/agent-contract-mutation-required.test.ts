import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_CONTRACT_SYSTEM_PROMPT,
  AgentContractValidationError,
  prepareAgentContractRequest,
  transformAgentContractCompletion
} from '../src/runtime/agent-contract.js';
import type { JsonObject, OpenAiCompletion } from '../src/types.js';

function completion(content: string): OpenAiCompletion {
  return {
    id: 'mutation-contract-test',
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

function body(route = 'code-generation'): JsonObject {
  return {
    model: 'chatgpt-web',
    messages: [
      { role: 'user', content: 'Crie backend e frontend e implemente o projeto.' }
    ],
    kitt_meta: {
      route,
      conversation_id: 'mutation-conversation',
      turn_id: 'mutation-turn',
      request_id: `mutation-${route}`
    },
    kitt_context: {
      schema_version: 1,
      epoch: `mutation-epoch-${route}`,
      segments: [
        {
          id: 'workspace',
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
          token_cost: 4,
          body_ref: { files: ['backend/', 'frontend/'] }
        },
        {
          id: 'output',
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
          token_cost: 2,
          body_ref: { discovery_required: false, loop_action_budget: 4 }
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
            operation: { type: 'string' },
            arguments: { type: 'object' }
          },
          required: ['operation', 'arguments'],
          additionalProperties: false
        }
      }
    }]
  };
}

function contract(action: Record<string, unknown>): string {
  return JSON.stringify({
    tool: null,
    tool_input: null,
    content: null,
    reasoning_summary: 'Execução do turno.',
    ...action
  });
}

test('contract explicitly defines TOOLS_AVAILABLE as remotely executable', () => {
  assert.match(AGENT_CONTRACT_SYSTEM_PROMPT, /TOOLS_AVAILABLE is the real executable surface/i);
  assert.match(AGENT_CONTRACT_SYSTEM_PROMPT, /action="use_tool"/i);
  assert.match(AGENT_CONTRACT_SYSTEM_PROMPT, /does not appear as a native tool/i);
});

test('implementation route rejects final response before any mutation attempt', () => {
  const plan = prepareAgentContractRequest(body(), { sessionId: 'mutation-required' });

  assert.equal(plan.mutationToolAvailable, true);
  assert.equal(plan.mutationRoundTripObserved, false);
  assert.throws(
    () => transformAgentContractCompletion(completion(contract({
      action: 'final_response',
      content: 'kitt_runtime não está exposta como ferramenta executável nesta conversa.'
    })), plan),
    (error: unknown) => error instanceof AgentContractValidationError
      && /requires a mutation attempt before final_response/i.test(error.message)
  );
});

test('mutation round trip alone does not satisfy validation requirement', () => {
  const firstPlan = prepareAgentContractRequest(body(), { sessionId: 'mutation-needs-validation' });
  const first = transformAgentContractCompletion(completion(contract({
    action: 'use_tool',
    tool: 'kitt_runtime',
    tool_input: { operation: 'repo.create_directory', arguments: { path: 'backend' } }
  })), firstPlan);
  const toolCall = first.choices[0]?.message.tool_calls?.[0];
  assert.ok(toolCall);

  const followUp = body();
  followUp.messages = [
    ...(followUp.messages as any[]),
    { role: 'assistant', content: null, tool_calls: [toolCall] },
    {
      role: 'tool',
      tool_call_id: toolCall.id,
      name: 'kitt_runtime',
      content: 'HOST_STATUS: success\nHOST_OUTPUT:\ncreated backend'
    }
  ];

  const secondPlan = prepareAgentContractRequest(followUp, { sessionId: 'mutation-needs-validation' });
  assert.equal(secondPlan.mutationRoundTripObserved, true);
  assert.equal(secondPlan.validationRequiredBeforeFinal, true);
  assert.equal(secondPlan.successfulValidationRoundTripObserved, false);
  assert.throws(
    () => transformAgentContractCompletion(completion(contract({
      action: 'final_response',
      content: 'Mutação concluída.'
    })), secondPlan),
    (error: unknown) => error instanceof AgentContractValidationError
      && /requires a successful host build\/test\/check/i.test(error.message)
  );
});

test('failed validation keeps final response blocked', () => {
  const firstPlan = prepareAgentContractRequest(body(), { sessionId: 'validation-failed' });
  const mutation = transformAgentContractCompletion(completion(contract({
    action: 'use_tool',
    tool: 'kitt_runtime',
    tool_input: { operation: 'repo.create_directory', arguments: { path: 'backend' } }
  })), firstPlan);
  const mutationCall = mutation.choices[0]?.message.tool_calls?.[0];
  assert.ok(mutationCall);

  const afterMutation = body();
  afterMutation.messages = [
    ...(afterMutation.messages as any[]),
    { role: 'assistant', content: null, tool_calls: [mutationCall] },
    {
      role: 'tool',
      tool_call_id: mutationCall.id,
      name: 'kitt_runtime',
      content: 'HOST_STATUS: success\nHOST_OUTPUT:\ncreated backend'
    }
  ];

  const validationPlan = prepareAgentContractRequest(afterMutation, { sessionId: 'validation-failed' });
  const validation = transformAgentContractCompletion(completion(contract({
    action: 'use_tool',
    tool: 'kitt_runtime',
    tool_input: {
      operation: 'process.run',
      arguments: { argv: ['npm', 'run', 'build'], cwd: 'backend' }
    }
  })), validationPlan);
  const validationCall = validation.choices[0]?.message.tool_calls?.[0];
  assert.ok(validationCall);

  const afterFailure = body();
  afterFailure.messages = [
    ...(afterMutation.messages as any[]),
    { role: 'assistant', content: null, tool_calls: [validationCall] },
    {
      role: 'tool',
      tool_call_id: validationCall.id,
      name: 'kitt_runtime',
      content: 'HOST_STATUS: error\nHOST_ERROR: Command exited with code 1\nHOST_OUTPUT:\nTS2551'
    }
  ];
  const failedPlan = prepareAgentContractRequest(afterFailure, { sessionId: 'validation-failed' });
  assert.equal(failedPlan.validationRoundTripObserved, true);
  assert.equal(failedPlan.successfulValidationRoundTripObserved, false);
  assert.throws(
    () => transformAgentContractCompletion(completion(contract({
      action: 'final_response',
      content: 'Build validado.'
    })), failedPlan),
    AgentContractValidationError
  );
});

test('successful validation after mutation allows final response', () => {
  const firstPlan = prepareAgentContractRequest(body(), { sessionId: 'validation-success' });
  const mutation = transformAgentContractCompletion(completion(contract({
    action: 'use_tool',
    tool: 'kitt_runtime',
    tool_input: { operation: 'repo.create_directory', arguments: { path: 'backend' } }
  })), firstPlan);
  const mutationCall = mutation.choices[0]?.message.tool_calls?.[0];
  assert.ok(mutationCall);

  const afterMutation = body();
  afterMutation.messages = [
    ...(afterMutation.messages as any[]),
    { role: 'assistant', content: null, tool_calls: [mutationCall] },
    {
      role: 'tool',
      tool_call_id: mutationCall.id,
      name: 'kitt_runtime',
      content: 'HOST_STATUS: success\nHOST_OUTPUT:\ncreated backend'
    }
  ];

  const validationPlan = prepareAgentContractRequest(afterMutation, { sessionId: 'validation-success' });
  const validation = transformAgentContractCompletion(completion(contract({
    action: 'use_tool',
    tool: 'kitt_runtime',
    tool_input: {
      operation: 'process.run',
      arguments: { argv: ['npm', 'run', 'build'], cwd: 'backend' }
    }
  })), validationPlan);
  const validationCall = validation.choices[0]?.message.tool_calls?.[0];
  assert.ok(validationCall);

  const afterSuccess = body();
  afterSuccess.messages = [
    ...(afterMutation.messages as any[]),
    { role: 'assistant', content: null, tool_calls: [validationCall] },
    {
      role: 'tool',
      tool_call_id: validationCall.id,
      name: 'kitt_runtime',
      content: 'HOST_STATUS: success\nHOST_OUTPUT:\nbuild completed'
    }
  ];
  const successPlan = prepareAgentContractRequest(afterSuccess, { sessionId: 'validation-success' });
  assert.equal(successPlan.successfulValidationRoundTripObserved, true);
  const result = transformAgentContractCompletion(completion(contract({
    action: 'final_response',
    content: 'Build validado com sucesso.'
  })), successPlan);
  assert.equal(result.choices[0]?.message.content, 'Build validado com sucesso.');
});

test('read-only tool round trip does not satisfy mutation requirement', () => {
  const firstPlan = prepareAgentContractRequest(body(), { sessionId: 'read-only-not-mutation' });
  const first = transformAgentContractCompletion(completion(contract({
    action: 'use_tool',
    tool: 'kitt_runtime',
    tool_input: { operation: 'repo.read', arguments: { path: 'backend' } }
  })), firstPlan);
  const toolCall = first.choices[0]?.message.tool_calls?.[0];
  assert.ok(toolCall);

  const followUp = body();
  followUp.messages = [
    ...(followUp.messages as any[]),
    { role: 'assistant', content: null, tool_calls: [toolCall] },
    {
      role: 'tool',
      tool_call_id: toolCall.id,
      name: 'kitt_runtime',
      content: '{"entries":[]}'
    }
  ];

  const secondPlan = prepareAgentContractRequest(followUp, { sessionId: 'read-only-not-mutation' });
  assert.equal(secondPlan.mutationRoundTripObserved, false);
  assert.throws(
    () => transformAgentContractCompletion(completion(contract({
      action: 'final_response',
      content: 'Nada a fazer.'
    })), secondPlan),
    AgentContractValidationError
  );
});

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
      {
        role: 'developer',
        content: `[KITT TURN CONTEXT]\n${JSON.stringify({
          route,
          workspace_context: { files: ['backend/', 'frontend/'] }
        })}`
      },
      { role: 'user', content: 'Crie backend e frontend e implemente o projeto.' }
    ],
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

test('mutating tool round trip allows a later final response', () => {
  const firstPlan = prepareAgentContractRequest(body(), { sessionId: 'mutation-observed' });
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
      content: '{"created":"backend"}'
    }
  ];

  const secondPlan = prepareAgentContractRequest(followUp, { sessionId: 'mutation-observed' });
  assert.equal(secondPlan.mutationRoundTripObserved, true);
  const result = transformAgentContractCompletion(completion(contract({
    action: 'final_response',
    content: 'A tentativa de mutação foi executada pelo host.'
  })), secondPlan);
  assert.equal(result.choices[0]?.message.content, 'A tentativa de mutação foi executada pelo host.');
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

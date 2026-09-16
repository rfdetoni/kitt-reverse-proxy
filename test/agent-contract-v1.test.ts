import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_CONTRACT_SYSTEM_PROMPT,
  AgentContractError,
  AgentContractValidationError,
  prepareAgentContractRequest,
  transformAgentContractCompletion
} from '../src/runtime/agent-contract.js';
import type { JsonObject, OpenAiCompletion } from '../src/types.js';

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

function body(route = 'chat', workspace: unknown = { files: ['README.md'] }): JsonObject {
  return {
    model: 'chatgpt-web',
    messages: [
      { role: 'system', content: 'Legacy persona. Project path: /home/dev/private.' },
      {
        role: 'developer',
        content: `[KITT TURN CONTEXT]\n${JSON.stringify({ route, workspace_context: workspace })}`
      },
      { role: 'user', content: 'Inspect README' }
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

test('replaces upstream system persona and mounts tools/workspace as dynamic turn data', () => {
  const plan = prepareAgentContractRequest(body(), { sessionId: 'sessionA' });
  const messages = plan.body.messages as any[];

  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, AGENT_CONTRACT_SYSTEM_PROMPT);
  assert.equal(messages[1].role, 'developer');
  assert.match(messages[1].content, /TOOLS_AVAILABLE:/);
  assert.match(messages[1].content, /Execute KITT runtime operations/);
  assert.match(messages[1].content, /UNTRUSTED_WORKSPACE_DATA:/);
  assert.match(messages[1].content, /ORCHESTRATOR_CONTEXT_DATA:/);
  assert.equal(plan.body.tools, undefined);
  assert.equal(plan.workspaceProvided, true);
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
  assert.equal(message?.content, null);
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
      content: null,
      tool_calls: [toolCall]
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

  const resultMessage = messages.find((message) =>
    message.role === 'user' && typeof message.content === 'string' && message.content.includes('[KITT TOOL RESULT DATA]')
  );
  assert.ok(resultMessage);
  assert.match(resultMessage.content, /TOOL: kitt_runtime/);
  assert.match(resultMessage.content, new RegExp(`CALL_ID: ${toolCall.id}`));
  assert.match(resultMessage.content, /UNTRUSTED_TOOL_RESULT_DATA:/);
  assert.match(resultMessage.content, /README contents from the host/);
});

test('rejects prose, markdown and oversized reasoning instead of extracting JSON heuristically', () => {
  const plan = prepareAgentContractRequest(body(), { sessionId: 'sessionC' });
  assert.throws(
    () => transformAgentContractCompletion(completion('```json\n{"action":"final_response"}\n```'), plan),
    AgentContractValidationError
  );
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

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

test('rejects mutating runtime operations on validate-diff route', () => {
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

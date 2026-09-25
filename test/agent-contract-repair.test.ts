import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAgentContractRepairBody,
  buildAgentContractSerializationRepairBody,
  contractExecutionOptions,
  contractRepairExecutionOptions,
  reinforceAgentContractPlan
} from '../src/proxy/openai-router.js';
import {
  AgentContractValidationError,
  prepareAgentContractRequest
} from '../src/runtime/agent-contract.js';
import type { JsonObject } from '../src/types.js';
import {
  canonicalLogicalMessages,
  canonicalMessages,
  userTurnsAreCompatible
} from '../src/runtime/ui-history.js';

function body(): JsonObject {
  return {
    model: 'chatgpt-web',
    messages: [
      {
        role: 'developer',
        content: `[KITT TURN CONTEXT]\n${JSON.stringify({
          route: 'code-edit',
          workspace_context: { files: ['.kitt-router.json'] }
        })}`
      },
      { role: 'user', content: 'Create backend and frontend.' }
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

test('turn constraints forbid redundant context requests before first execution', () => {
  const plan = reinforceAgentContractPlan(
    prepareAgentContractRequest(body(), { sessionId: 'repair-first-turn' })
  );
  const messages = plan.body.messages as Array<{ role?: string; content?: string }>;
  const constraint = messages.find((message) =>
    message.role === 'developer' && message.content?.includes('[KITT ACTION CONSTRAINTS]')
  );

  assert.ok(constraint?.content);
  assert.match(constraint.content, /request_tools is forbidden/);
  assert.match(constraint.content, /AVAILABLE_TOOL_NAMES: \["kitt_runtime"\]/);
  assert.match(constraint.content, /request_workspace is forbidden/);
});

test('turn constraints preserve the final actionable UI turn', () => {
  const plan = reinforceAgentContractPlan(
    prepareAgentContractRequest(body(), { sessionId: 'repair-ui-ordering' })
  );
  const messages = plan.body.messages as Array<{ role?: string; content?: string }>;
  const constraintIndex = messages.findIndex((message) =>
    message.role === 'developer' && message.content?.includes('[KITT ACTION CONSTRAINTS]')
  );
  let lastActionableIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const role = messages[index]?.role;
    if (role === 'user' || role === 'tool') {
      lastActionableIndex = index;
      break;
    }
  }

  assert.ok(constraintIndex >= 0);
  assert.ok(lastActionableIndex > constraintIndex);
  assert.equal(messages.at(-1)?.role, 'user');
  assert.match(messages.at(-1)?.content ?? '', /Create backend and frontend/);
});

test('semantic retry includes the validation cause and available tool names', () => {
  const plan = reinforceAgentContractPlan(
    prepareAgentContractRequest(body(), { sessionId: 'repair-retry' })
  );
  const retry = buildAgentContractRepairBody(
    plan,
    new AgentContractValidationError(
      'request_tools is incompatible with TOOLS_AVAILABLE that has already been supplied.'
    )
  );
  const messages = retry.messages as Array<{ role?: string; content?: string }>;
  const repair = messages.at(-1)?.content ?? '';

  assert.match(repair, /PREVIOUS_VALIDATION_ERROR: request_tools is incompatible/);
  assert.match(repair, /request_tools is forbidden/);
  assert.match(repair, /AVAILABLE_TOOL_NAMES: \["kitt_runtime"\]/);
  assert.match(repair, /request_workspace is forbidden/);
  assert.match(repair, /Do not repeat the invalid action/);
});


test('semantic repair preserves caller-visible history without volatile turn context', () => {
  const plan = reinforceAgentContractPlan(
    prepareAgentContractRequest(body(), { sessionId: 'repair-history-isolation' })
  );
  const options = contractRepairExecutionOptions(plan, {});
  const logical = options.logicalHistoryBody as JsonObject;

  assert.notEqual(logical, plan.originalBody);
  const messages = logical.messages as Array<{ role?: string; content?: string }>;
  const content = messages.map((message) => message.content ?? '').join('\n');
  assert.match(content, /Create backend and frontend/);
  assert.doesNotMatch(content, /\[KITT TURN CONTEXT\]/);
  assert.doesNotMatch(content, /\[KITT ORCHESTRATOR TURN DATA\]/);
  assert.doesNotMatch(content, /\[KITT ACTION CONSTRAINTS\]/);
  assert.doesNotMatch(content, /\[KITT CONTRACT REPAIR\]/);
});


test('contract logical history stays caller-stable across a host tool round trip', () => {
  const sessionId = 'caller-history-round-trip';
  const firstPlan = reinforceAgentContractPlan(
    prepareAgentContractRequest(body(), { sessionId })
  );
  const firstLogical = canonicalLogicalMessages(
    firstPlan.body,
    contractExecutionOptions(firstPlan, {}).logicalHistoryBody
  );

  const followUp = body();
  const toolCall = {
    id: 'call_list_workspace',
    type: 'function',
    function: {
      name: 'kitt_runtime',
      arguments: JSON.stringify({
        operation: 'repo.list',
        arguments: { path: '', recursive: true, max_depth: 5 }
      })
    }
  };
  (followUp.messages as any[]).push(
    { role: 'assistant', content: null, tool_calls: [toolCall] },
    {
      role: 'tool',
      tool_call_id: toolCall.id,
      name: 'kitt_runtime',
      content: '{"entries":[]}'
    }
  );

  const secondPlan = reinforceAgentContractPlan(
    prepareAgentContractRequest(followUp, { sessionId })
  );
  const secondLogical = canonicalLogicalMessages(
    secondPlan.body,
    contractExecutionOptions(secondPlan, {}).logicalHistoryBody
  );
  const secondTransport = canonicalMessages(secondPlan.body);

  assert.equal(secondTransport.filter((message) => message.role === 'user').length, 2);
  assert.equal(secondLogical.filter((message) => message.role === 'user').length, 1);
  assert.equal(secondLogical.find((message) => message.role === 'user')?.text, 'Create backend and frontend.');
  assert.doesNotThrow(() => userTurnsAreCompatible(
    [...firstLogical, { role: 'assistant', text: 'tool requested' }],
    secondLogical
  ));
});


test('serialization repair explicitly requires escaped JSON strings', () => {
  const plan = reinforceAgentContractPlan(
    prepareAgentContractRequest(body(), { sessionId: 'serialization-repair' })
  );
  const retry = buildAgentContractSerializationRepairBody(
    plan,
    new AgentContractValidationError('The model response is not a pure JSON object.')
  );
  const messages = retry.messages as Array<{ role?: string; content?: string }>;
  const repair = messages.at(-1)?.content ?? '';

  assert.match(repair, /KITT CONTRACT SERIALIZATION REPAIR/);
  assert.match(repair, /Escape every newline, tab, backslash, quote/);
  assert.match(repair, /Never place literal newlines inside a JSON string/);
  assert.match(repair, /preserve the original file indentation and line breaks exactly/);
  assert.match(repair, /Never flatten or minify file content/);
  assert.match(repair, /wrap the entire contract object in exactly one/);
  assert.match(repair, /tool_input must remain a JSON object/);
  assert.match(repair, /AVAILABLE_TOOL_NAMES: \["kitt_runtime"\]/);
});


test('direct chat without tools or workspace forbids dead-end context requests', () => {
  const request: JsonObject = {
    model: 'gemini-web',
    messages: [{ role: 'user', content: 'Explain dependency injection briefly.' }]
  };
  const plan = reinforceAgentContractPlan(
    prepareAgentContractRequest(request, {
      sessionId: 'direct-chat-constraints',
      route: 'chat'
    })
  );
  const messages = plan.body.messages as Array<{ role?: string; content?: string }>;
  const constraint = messages.find((message) =>
    message.role === 'developer' && message.content?.includes('DIRECT_CHAT_NO_EXTERNAL_CONTEXT')
  )?.content ?? '';

  assert.match(constraint, /request_tools and request_workspace are forbidden/);
  assert.match(constraint, /final_response/);
});

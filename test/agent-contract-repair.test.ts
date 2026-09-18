import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAgentContractRepairBody,
  contractRepairExecutionOptions,
  reinforceAgentContractPlan
} from '../src/proxy/openai-router.js';
import {
  AgentContractValidationError,
  prepareAgentContractRequest
} from '../src/runtime/agent-contract.js';
import type { JsonObject } from '../src/types.js';

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

test('semantic retry includes the validation cause and available tool names', () => {
  const plan = reinforceAgentContractPlan(
    prepareAgentContractRequest(body(), { sessionId: 'repair-retry' })
  );
  const retry = buildAgentContractRepairBody(
    plan,
    new AgentContractValidationError(
      'request_tools é incompatível com TOOLS_AVAILABLE já fornecido.'
    )
  );
  const messages = retry.messages as Array<{ role?: string; content?: string }>;
  const repair = messages.at(-1)?.content ?? '';

  assert.match(repair, /PREVIOUS_VALIDATION_ERROR: request_tools é incompatível/);
  assert.match(repair, /request_tools is forbidden/);
  assert.match(repair, /AVAILABLE_TOOL_NAMES: \["kitt_runtime"\]/);
  assert.match(repair, /request_workspace is forbidden/);
  assert.match(repair, /Do not repeat the invalid action/);
});


test('semantic repair preserves the original caller-visible history', () => {
  const plan = reinforceAgentContractPlan(
    prepareAgentContractRequest(body(), { sessionId: 'repair-history-isolation' })
  );
  const options = contractRepairExecutionOptions(plan, {});
  const logical = options.logicalHistoryBody as JsonObject;

  assert.equal(logical, plan.body);
  const messages = logical.messages as Array<{ role?: string; content?: string }>;
  assert.equal(
    messages.some((message) => message.content?.includes('[KITT CONTRACT REPAIR]')),
    false
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentContractValidationError,
  prepareAgentContractRequest,
  transformAgentContractCompletion
} from '../src/runtime/agent-contract.js';
import type { JsonObject, OpenAiCompletion } from '../src/types.js';

function completion(content: string): OpenAiCompletion {
  return {
    id: 'discovery-first',
    object: 'chat.completion',
    created: 1,
    model: 'gemini-web',
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop'
    }]
  };
}

function request(messages?: JsonObject[]): JsonObject {
  return {
    model: 'gemini-web',
    messages: messages ?? [
      { role: 'user', content: 'Intent: IMPLEMENT\n\nGoal:\nBuild the application.' }
    ],
    kitt_meta: {
      route: 'code-generation',
      conversation_id: 'discovery-conversation',
      turn_id: 'discovery-turn',
      request_id: 'discovery-request'
    },
    kitt_context: {
      schema_version: 1,
      epoch: 'discovery-epoch',
      segments: [
        {
          id: 'memory',
          kind: 'MEMORY_RECALL',
          source: 'kitt-memoryd',
          trust: 'TRUSTED',
          stability: 'SESSION',
          priority: 90,
          sensitivity: 'private',
          recovery: 'SOURCE_REF',
          cache_region: 'SESSION_PREFIX',
          lifecycle: 'session',
          provenance_digest: 'memory',
          token_cost: 2,
          body_ref: { text: 'trusted memory' }
        },
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
          body_ref: { files: ['package.json'] }
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
          body_ref: {
            discovery_required: true,
            execution_phase: 'discovery',
            loop_action_budget: 4
          }
        }
      ]
    },
    tools: [{
      type: 'function',
      function: {
        name: 'kitt_runtime',
        description: 'KITT runtime',
        parameters: {
          type: 'object',
          properties: {
            operation: {
              type: 'string',
              enum: ['repo.list', 'repo.read', 'repo.write_file', 'patch.apply']
            },
            arguments: { type: 'object' }
          },
          required: ['operation', 'arguments']
        }
      }
    }]
  };
}


test('bootstrap prompt is staged and does not resend generated persona/tool contract', () => {
  const source = request([
    { role: 'user', content: 'Intent: IMPLEMENT\n\nGoal:\nBuild the application.' }
  ]);
  const plan = prepareAgentContractRequest(source, {
    sessionId: 'staged-superprompt-regression',
    route: 'code-generation'
  });
  const text = (plan.body.messages as Array<{ content?: string }>)
    .map((message) => message.content ?? '')
    .join('\n');

  assert.match(text, /EXECUTION_PLAN: discovery -> mutation -> validation/);
  assert.match(text, /EXECUTION_PHASE: discovery/);
  assert.match(text, /PHASE_RULE: choose one host action/);
  assert.doesNotMatch(text, /You are an autonomous coding agent operating inside the user's workspace/);
  assert.doesNotMatch(text, /Tool Contract:/);
  assert.match(text, /trusted memory/);
});

test('discovery-first contract rejects mutation before repository evidence', () => {
  const plan = prepareAgentContractRequest(request(), {
    sessionId: 'discovery-first-block',
    route: 'code-generation'
  });
  assert.equal(plan.discoveryRequired, true);
  assert.equal(plan.explorationRoundTripObserved, false);

  assert.throws(
    () => transformAgentContractCompletion(completion(JSON.stringify({
      action: 'use_tool',
      tool: 'kitt_runtime',
      tool_input: {
        operation: 'repo.write_file',
        arguments: { path: 'src/app.ts', content: 'export const app = true;' }
      },
      content: null,
      reasoning_summary: 'Create the first file.'
    })), plan),
    AgentContractValidationError
  );
});

test('discovery-first contract allows mutation after a read result round trip', () => {
  const first = prepareAgentContractRequest(request(), {
    sessionId: 'discovery-first-allow',
    route: 'code-generation'
  });
  const readCompletion = transformAgentContractCompletion(completion(JSON.stringify({
    action: 'use_tool',
    tool: 'kitt_runtime',
    tool_input: { operation: 'repo.list', arguments: { path: '.' } },
    content: null,
    reasoning_summary: 'Inspect workspace.'
  })), first);
  const call = readCompletion.choices[0]?.message.tool_calls?.[0];
  assert.ok(call);

  const follow = request([
    { role: 'user', content: 'Intent: IMPLEMENT\n\nGoal:\nBuild the application.' },
    { role: 'assistant', content: null, tool_calls: [call] } as unknown as JsonObject,
    { role: 'tool', tool_call_id: call.id, name: 'kitt_runtime', content: 'package.json\nsrc/' } as unknown as JsonObject
  ]);
  const second = prepareAgentContractRequest(follow, {
    sessionId: 'discovery-first-allow',
    route: 'code-generation'
  });

  assert.equal(second.discoveryRequired, true);
  assert.equal(second.explorationRoundTripObserved, true);
  assert.doesNotThrow(() => transformAgentContractCompletion(completion(JSON.stringify({
    action: 'use_tool',
    tool: 'kitt_runtime',
    tool_input: {
      operation: 'repo.write_file',
      arguments: { path: 'src/app.ts', content: 'export const app = true;' }
    },
    content: null,
    reasoning_summary: 'Apply the next milestone.'
  })), second));
});

test('structured turn context enables discovery without preserving the textual tool contract marker', () => {
  const staged = request([
    { role: 'user', content: 'Intent: IMPLEMENT\n\nGoal:\nBuild the application.' }
  ]);
  const plan = prepareAgentContractRequest(staged, {
    sessionId: 'discovery-structured-envelope',
    route: 'code-generation'
  });

  assert.equal(plan.discoveryRequired, true);
  assert.equal(plan.explorationRoundTripObserved, false);
  const user = (plan.body.messages as Array<{ role?: string; content?: string }>)
    .find((message) => message.role === 'user')?.content ?? '';
  assert.match(user, /EXECUTION_PHASE: discovery/);
  assert.match(user, /exactly one read-only repository inspection/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentContractValidationError,
  prepareAgentContractRequest,
  recordAgentContractValidation,
  transformAgentContractCompletion
} from '../src/runtime/agent-contract.js';
import type { JsonObject, OpenAiCompletion } from '../src/types.js';

function completion(payload: Record<string, unknown>): OpenAiCompletion {
  return {
    id: 'loop-contract-test',
    object: 'chat.completion',
    created: 1,
    model: 'chatgpt-web',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: JSON.stringify(payload) },
      finish_reason: 'stop'
    }]
  };
}

function loop(status: 'active' | 'checkpoint' | 'complete' = 'active') {
  return {
    objective: 'Advance the next evidence-backed implementation slice.',
    completion_criteria: ['The current slice is implemented or proven unnecessary.'],
    status,
    validation_summary: status === 'checkpoint' ? 'Checkpoint based on host evidence.' : ''
  };
}

function contract(action: Record<string, unknown>) {
  return {
    action: 'final_response',
    tool: null,
    tool_input: null,
    content: 'done',
    reasoning_summary: 'Public progress summary.',
    loop: loop('complete'),
    ...action
  };
}

function body(prompt = 'Implemente a solicitação sem reinterpretar meu texto.', budget = 4): JsonObject {
  return {
    model: 'chatgpt-web',
    messages: [{ role: 'user', content: prompt }],
    kitt_meta: {
      route: 'agent-loop',
      conversation_id: 'loop-conversation',
      turn_id: 'loop-turn',
      request_id: `loop-request-${budget}`
    },
    kitt_context: {
      schema_version: 1,
      epoch: `loop-epoch-${budget}`,
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
          body_ref: { files: ['package.json', 'src/'] }
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
            loop_action_budget: budget,
            discovery_required: true
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
              enum: ['repo.list', 'repo.read', 'repo.write_file', 'patch.apply', 'process.run']
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

function appendRoundTrip(source: JsonObject, toolCall: NonNullable<OpenAiCompletion['choices'][number]['message']['tool_calls']>[number], result: string): JsonObject {
  return {
    ...source,
    messages: [
      ...((source.messages as JsonObject[]) ?? []),
      { role: 'assistant', content: null, tool_calls: [toolCall] } as unknown as JsonObject,
      {
        role: 'tool',
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: result
      } as unknown as JsonObject
    ]
  };
}

test('agent-loop preserves arbitrary-language user request and does not strengthen route lexically', () => {
  for (const prompt of [
    'Não crie backend; altere somente o que eu pedi.',
    'バックエンドを作成せず、要求された範囲だけ変更してください。',
    'Erstellen Sie kein Backend; ändern Sie nur den angeforderten Bereich.'
  ]) {
    const plan = prepareAgentContractRequest(body(prompt), {
      sessionId: `language-${prompt.length}`,
      route: 'agent-loop'
    });
    assert.equal(plan.route, 'agent-loop');
    const text = (plan.body.messages as Array<{ content?: string }>)
      .map((message) => message.content ?? '')
      .join('\n');
    assert.match(text, new RegExp(prompt.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&')));
    assert.match(text, /ORIGINAL_USER_REQUEST_IS_AUTHORITATIVE: true/);
  }
});

test('agent-loop may answer directly when no host mutation is required', () => {
  const plan = prepareAgentContractRequest(body('Explique o estado atual sem alterar arquivos.'), {
    sessionId: 'direct-complete',
    route: 'agent-loop'
  });
  const result = transformAgentContractCompletion(completion(contract({})), plan);
  assert.equal(result.choices[0]?.message.content, 'done');
});

test('agent-loop rejects mutation before repository evidence and allows read inspection', () => {
  const plan = prepareAgentContractRequest(body(), {
    sessionId: 'inspect-before-mutate',
    route: 'agent-loop'
  });

  assert.throws(
    () => transformAgentContractCompletion(completion(contract({
      action: 'use_tool',
      tool: 'kitt_runtime',
      tool_input: { operation: 'repo.write_file', arguments: { path: 'x.txt', content: 'x' } },
      content: null,
      loop: loop('active')
    })), plan),
    AgentContractValidationError
  );

  assert.doesNotThrow(() => transformAgentContractCompletion(completion(contract({
    action: 'use_tool',
    tool: 'kitt_runtime',
    tool_input: { operation: 'repo.list', arguments: { path: '.' } },
    content: null,
    loop: loop('active')
  })), plan));
});

test('mutation requires successful host validation before final response', () => {
  const base = body();
  const firstPlan = prepareAgentContractRequest(base, {
    sessionId: 'loop-validation',
    route: 'agent-loop'
  });
  const read = transformAgentContractCompletion(completion(contract({
    action: 'use_tool',
    tool: 'kitt_runtime',
    tool_input: { operation: 'repo.list', arguments: { path: '.' } },
    content: null,
    loop: loop('active')
  })), firstPlan);
  const readCall = read.choices[0]!.message.tool_calls![0]!;

  const afterRead = appendRoundTrip(base, readCall, 'HOST_STATUS: success\npackage.json\nsrc/');
  const mutationPlan = prepareAgentContractRequest(afterRead, {
    sessionId: 'loop-validation',
    route: 'agent-loop'
  });
  const mutation = transformAgentContractCompletion(completion(contract({
    action: 'use_tool',
    tool: 'kitt_runtime',
    tool_input: { operation: 'repo.write_file', arguments: { path: 'src/x.ts', content: 'export const x = 1;' } },
    content: null,
    loop: loop('active')
  })), mutationPlan);
  const mutationCall = mutation.choices[0]!.message.tool_calls![0]!;

  const afterMutation = appendRoundTrip(afterRead, mutationCall, 'HOST_STATUS: success\nwritten src/x.ts');
  const validationPlan = prepareAgentContractRequest(afterMutation, {
    sessionId: 'loop-validation',
    route: 'agent-loop'
  });
  assert.equal(validationPlan.validationRequiredBeforeFinal, true);
  assert.throws(
    () => transformAgentContractCompletion(completion(contract({})), validationPlan),
    AgentContractValidationError
  );

  const validation = transformAgentContractCompletion(completion(contract({
    action: 'use_tool',
    tool: 'kitt_runtime',
    tool_input: { operation: 'process.run', arguments: { argv: ['npm', 'run', 'build'], cwd: '.' } },
    content: null,
    loop: loop('active')
  })), validationPlan);
  const validationCall = validation.choices[0]!.message.tool_calls![0]!;
  const afterValidation = appendRoundTrip(
    afterMutation,
    validationCall,
    'HOST_STATUS: success\nbuild completed'
  );
  const completePlan = prepareAgentContractRequest(afterValidation, {
    sessionId: 'loop-validation',
    route: 'agent-loop'
  });
  assert.equal(completePlan.successfulValidationRoundTripObserved, true);
  assert.doesNotThrow(
    () => transformAgentContractCompletion(completion(contract({})), completePlan)
  );
});

test('configured action budget starts a new bounded loop after checkpoint tool action', () => {
  const base = body('Implemente em loops curtos.', 2);
  const firstPlan = prepareAgentContractRequest(base, {
    sessionId: 'checkpoint-budget',
    route: 'agent-loop'
  });
  const read = transformAgentContractCompletion(completion(contract({
    action: 'use_tool',
    tool: 'kitt_runtime',
    tool_input: { operation: 'repo.list', arguments: { path: '.' } },
    content: null,
    loop: loop('active')
  })), firstPlan);
  const readCall = read.choices[0]!.message.tool_calls![0]!;

  const afterRead = appendRoundTrip(base, readCall, 'HOST_STATUS: success\nsrc/');
  const secondPlan = prepareAgentContractRequest(afterRead, {
    sessionId: 'checkpoint-budget',
    route: 'agent-loop'
  });
  assert.equal(secondPlan.loopIndex, 1);
  assert.equal(secondPlan.loopActionCount, 1);

  const second = transformAgentContractCompletion(completion(contract({
    action: 'use_tool',
    tool: 'kitt_runtime',
    tool_input: { operation: 'repo.read', arguments: { path: 'src/app.ts' } },
    content: null,
    loop: loop('active')
  })), secondPlan);
  const secondCall = second.choices[0]!.message.tool_calls![0]!;

  const afterSecond = appendRoundTrip(afterRead, secondCall, 'HOST_STATUS: success\nexport const app = true;');
  const checkpointPlan = prepareAgentContractRequest(afterSecond, {
    sessionId: 'checkpoint-budget',
    route: 'agent-loop'
  });

  assert.equal(checkpointPlan.hostRoundTripCount, 2);
  assert.equal(checkpointPlan.loopIndex, 1);
  assert.equal(checkpointPlan.loopActionCount, 2);
  assert.equal(checkpointPlan.loopActionBudget, 2);
  assert.equal(checkpointPlan.checkpointRequired, true);

  assert.throws(
    () => transformAgentContractCompletion(completion(contract({
      action: 'use_tool',
      tool: 'kitt_runtime',
      tool_input: { operation: 'repo.read', arguments: { path: 'package.json' } },
      content: null,
      loop: loop('active')
    })), checkpointPlan),
    AgentContractValidationError
  );

  const checkpoint = transformAgentContractCompletion(completion(contract({
    action: 'use_tool',
    tool: 'kitt_runtime',
    tool_input: { operation: 'repo.read', arguments: { path: 'package.json' } },
    content: null,
    loop: loop('checkpoint')
  })), checkpointPlan);
  const checkpointCall = checkpoint.choices[0]!.message.tool_calls![0]!;
  assert.match(checkpointCall.id, /^call_loop_/);

  const afterCheckpoint = appendRoundTrip(
    afterSecond,
    checkpointCall,
    'HOST_STATUS: success\n{"name":"kitt"}'
  );
  const nextLoopPlan = prepareAgentContractRequest(afterCheckpoint, {
    sessionId: 'checkpoint-budget',
    route: 'agent-loop'
  });

  assert.equal(nextLoopPlan.hostRoundTripCount, 3);
  assert.equal(nextLoopPlan.loopIndex, 2);
  assert.equal(nextLoopPlan.loopActionCount, 1);
  assert.equal(nextLoopPlan.checkpointRequired, false);
  const nextContext = (nextLoopPlan.body.messages as Array<{ content?: string }>)
    .map((message) => message.content ?? '')
    .join('\n');
  assert.match(nextContext, /LOOP_INDEX: 2/);
  assert.match(nextContext, /LOOP_ACTION_COUNT: 1/);
  assert.match(nextContext, /TURN_TOOL_CALL_COUNT: 3/);
  assert.match(nextContext, /CHECKPOINT_REQUIRED: false/);
});

test('contract failure reinjection uses cooldown instead of repeated bootstrap', () => {
  const sessionId = 'reinject-cooldown';
  const first = prepareAgentContractRequest(body(), { sessionId, route: 'agent-loop' });
  const firstText = (first.body.messages as Array<{ content?: string }>)
    .map((message) => message.content ?? '')
    .join('\n');
  assert.match(firstText, /CONTEXT_MODE: bootstrap/);

  recordAgentContractValidation(sessionId, false);
  recordAgentContractValidation(sessionId, false);
  recordAgentContractValidation(sessionId, true);
  recordAgentContractValidation(sessionId, true);

  const reinjected = prepareAgentContractRequest(body(), { sessionId, route: 'agent-loop' });
  const reinjectedText = (reinjected.body.messages as Array<{ content?: string }>)
    .map((message) => message.content ?? '')
    .join('\n');
  assert.match(reinjectedText, /CONTEXT_MODE: bootstrap/);

  const cooled = prepareAgentContractRequest(body(), { sessionId, route: 'agent-loop' });
  const cooledText = (cooled.body.messages as Array<{ content?: string }>)
    .map((message) => message.content ?? '')
    .join('\n');
  assert.match(cooledText, /CONTEXT_MODE: delta/);
});

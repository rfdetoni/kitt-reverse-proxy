import test from 'node:test';
import assert from 'node:assert/strict';
import { buildToolEnforcementPlan, enforceToolResponse } from '../src/runtime/tool-enforcement.js';

const protocol = {
  tools: [{ name: 'kitt_runtime', description: 'safe runtime', parameters: { type: 'object' } }],
  choice: { mode: 'auto' },
  systemPrompt: ''
} as any;

test('direct folder creation requires a mutation tool without workspace exploration', () => {
  const plan = buildToolEnforcementPlan(protocol, 'crie uma pasta teste', 'explore-first');
  assert.equal(plan.enabled, true);
  assert.equal(plan.workspaceDependent, false);
  assert.equal(plan.requireExploration, false);
  assert.equal(plan.requireAnyTool, true);
  assert.equal(plan.requireMutation, true);
});

test('direct file creation requires a mutation tool without workspace exploration', () => {
  const plan = buildToolEnforcementPlan(protocol, 'crie um arquivo src/new-file.ts', 'explore-first');
  assert.equal(plan.enabled, true);
  assert.equal(plan.workspaceDependent, false);
  assert.equal(plan.requireExploration, false);
  assert.equal(plan.requireMutation, true);
});

test('direct mkdir command does not require an exploratory round trip', () => {
  const plan = buildToolEnforcementPlan(protocol, 'execute: mkdir -p teste', 'explore-first');
  assert.equal(plan.requireExploration, false);
  assert.equal(plan.requireAnyTool, true);
  assert.equal(plan.requireMutation, true);

  assert.throws(() => enforceToolResponse({
    enforcement: plan,
    protocol,
    calls: [],
    explorationEvidence: false,
    toolEvidence: false
  }), /mutation tool call is required/i);

  assert.doesNotThrow(() => enforceToolResponse({
    enforcement: plan,
    protocol,
    calls: [{
      id: 'call1',
      type: 'function',
      function: {
        name: 'kitt_runtime',
        arguments: JSON.stringify({ operation: 'process.run', arguments: { command: 'mkdir -p teste' } })
      }
    }] as any,
    explorationEvidence: false,
    toolEvidence: false
  }));
});

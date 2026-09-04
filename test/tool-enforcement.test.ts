import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ToolEnforcementError,
  buildToolEnforcementPlan,
  enforceToolResponse,
  isExplorationToolCall,
  isMutationToolCall,
  isWorkspaceDependentRequest,
  toolEnforcementTaskKey
} from '../src/runtime/tool-enforcement.js';
import { buildToolProtocolPlan, type OpenAiToolCall } from '../src/mapping/tool-calling.js';

function protocol() {
  return buildToolProtocolPlan({
    messages: [],
    tools: [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file from the workspace',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'write_file',
          description: 'Write a file in the workspace',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' }
            },
            required: ['path', 'content']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'execute_command',
          description: 'Execute a shell command',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command']
          }
        }
      }
    ]
  });
}

function call(name: string, args: Record<string, unknown>): OpenAiToolCall {
  return {
    id: `call_${name}`,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args)
    }
  };
}

test('detects coding requests that require workspace evidence', () => {
  assert.equal(isWorkspaceDependentRequest('aprimore esta classe'), true);
  assert.equal(isWorkspaceDependentRequest('corrija src/runtime/ui-executor.ts'), true);
  assert.equal(isWorkspaceDependentRequest('explique o que é uma classe em Java'), false);
});

test('explore-first rejects a final answer before workspace exploration', () => {
  const p = protocol();
  const enforcement = buildToolEnforcementPlan(p, 'aprimore esta classe', 'explore-first');
  assert.throws(
    () => enforceToolResponse({
      enforcement,
      protocol: p,
      calls: [],
      explorationEvidence: false,
      toolEvidence: false
    }),
    ToolEnforcementError
  );
});

test('explore-first rejects write-before-read', () => {
  const p = protocol();
  const enforcement = buildToolEnforcementPlan(p, 'corrija o arquivo', 'explore-first');
  assert.throws(
    () => enforceToolResponse({
      enforcement,
      protocol: p,
      calls: [call('write_file', { path: 'a.ts', content: 'x' })],
      explorationEvidence: false,
      toolEvidence: false
    }),
    (error: unknown) =>
      error instanceof ToolEnforcementError && error.reason === 'read_before_write'
  );
});

test('exploration call is allowed before evidence exists', () => {
  const p = protocol();
  const enforcement = buildToolEnforcementPlan(p, 'corrija o arquivo', 'explore-first');
  assert.doesNotThrow(() => enforceToolResponse({
    enforcement,
    protocol: p,
    calls: [call('read_file', { path: 'src/a.ts' })],
    explorationEvidence: false,
    toolEvidence: false
  }));
});

test('after exploration evidence a final answer and writes are allowed', () => {
  const p = protocol();
  const enforcement = buildToolEnforcementPlan(p, 'corrija o arquivo', 'explore-first');
  assert.doesNotThrow(() => enforceToolResponse({
    enforcement,
    protocol: p,
    calls: [],
    explorationEvidence: true,
    toolEvidence: true
  }));
  assert.doesNotThrow(() => enforceToolResponse({
    enforcement,
    protocol: p,
    calls: [call('write_file', { path: 'a.ts', content: 'x' })],
    explorationEvidence: true,
    toolEvidence: true
  }));
});

test('required mode forces a tool even for non-workspace requests', () => {
  const p = protocol();
  const enforcement = buildToolEnforcementPlan(p, 'qual é a capital do Brasil?', 'required');
  assert.throws(() => enforceToolResponse({
    enforcement,
    protocol: p,
    calls: [],
    explorationEvidence: false,
    toolEvidence: false
  }), ToolEnforcementError);
});

test('execute_command counts only when command is read-only', () => {
  const p = protocol();
  assert.equal(
    isExplorationToolCall(call('execute_command', { command: 'rg -n "SessionManager" src' }), p),
    true
  );
  assert.equal(
    isExplorationToolCall(call('execute_command', { command: 'rm -rf dist' }), p),
    false
  );
  assert.equal(
    isMutationToolCall(call('execute_command', { command: 'rm -rf dist' }), p),
    true
  );
});

test('task key stays stable through tool result and changes on new user turn', () => {
  const original = toolEnforcementTaskKey([
    { role: 'user', text: 'corrija esta classe' }
  ]);
  const withTool = toolEnforcementTaskKey([
    { role: 'user', text: 'corrija esta classe' },
    { role: 'assistant', text: '' },
    { role: 'tool', text: 'resultado', toolCallId: 'call_read' }
  ]);
  const nextUser = toolEnforcementTaskKey([
    { role: 'user', text: 'corrija esta classe' },
    { role: 'tool', text: 'resultado', toolCallId: 'call_read' },
    { role: 'user', text: 'corrija esta classe' }
  ]);
  assert.equal(original, withTool);
  assert.notEqual(original, nextUser);
});

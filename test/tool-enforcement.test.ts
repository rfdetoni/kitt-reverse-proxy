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
import { runtimeOperationEffect } from '../src/runtime/tool-policy.js';
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

function runtimeProtocol() {
  return buildToolProtocolPlan({ tools: [{ type: 'function', function: { name: 'kitt_runtime' } }] });
}

function runtimeCall(operation: string, args: Record<string, unknown> = {}): OpenAiToolCall {
  return call('kitt_runtime', { operation, arguments: args });
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

test('after exploration mutation requests still require a mutation result', () => {
  const p = protocol();
  const enforcement = buildToolEnforcementPlan(p, 'corrija o arquivo', 'explore-first');
  assert.equal(enforcement.requireMutation, true);
  assert.throws(() => enforceToolResponse({
    enforcement,
    protocol: p,
    calls: [],
    explorationEvidence: true,
    toolEvidence: true
  }), (error: unknown) => error instanceof ToolEnforcementError && error.reason === 'mutation_required');
  assert.doesNotThrow(() => enforceToolResponse({
    enforcement,
    protocol: p,
    calls: [call('write_file', { path: 'a.ts', content: 'x' })],
    explorationEvidence: true,
    toolEvidence: true
  }));
  assert.doesNotThrow(() => enforceToolResponse({
    enforcement,
    protocol: p,
    calls: [],
    explorationEvidence: true,
    toolEvidence: true,
    mutationEvidence: true
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

test('KITT compact runtime enforces repo exploration before patch or process mutations', () => {
  const p = runtimeProtocol();
  const enforcement = buildToolEnforcementPlan(p, 'corrija o projeto', 'explore-first');
  assert.equal(enforcement.requireExploration, true);
  assert.equal(enforcement.requireMutation, true);
  const read = runtimeCall('repo.read', { path: 'README.md' });
  const patch = runtimeCall('patch.apply', { patch: 'x' });
  assert.equal(isExplorationToolCall(read, p), true);
  assert.equal(isExplorationToolCall(patch, p), false);
  assert.equal(isMutationToolCall(patch, p), true);
  assert.throws(() => enforceToolResponse({ enforcement, protocol: p, calls: [read, patch], explorationEvidence: false, toolEvidence: false }), ToolEnforcementError);
  assert.equal(isExplorationToolCall(runtimeCall('process.run', { command: 'rtk proxy git status' }), p), true);
});

test('KITT runtime policy covers semantic exploration without treating read-only operations as mutations', () => {
  const p = runtimeProtocol();
  for (const operation of [
    'repo.context_map',
    'repo.definition',
    'repo.hover',
    'repo.references_semantic',
    'repo.diagnostics',
    'repo.call_hierarchy',
    'repo.outline',
    'repo.ast_search',
    'security.scan'
  ]) {
    assert.equal(runtimeOperationEffect(operation), 'explore', operation);
    assert.equal(isExplorationToolCall(runtimeCall(operation), p), true, operation);
    assert.equal(isMutationToolCall(runtimeCall(operation), p), false, operation);
  }

  for (const operation of ['artifacts.read', 'children.inspect', 'goal.inspect', 'memory.query', 'session.search', 'state.get', 'state.list', 'handles.resolve']) {
    assert.equal(runtimeOperationEffect(operation), 'neutral', operation);
    assert.equal(isExplorationToolCall(runtimeCall(operation), p), false, operation);
    assert.equal(isMutationToolCall(runtimeCall(operation), p), false, operation);
  }

  for (const operation of ['repo.write_file', 'repo.create_directory', 'repo.move', 'repo.rename', 'repo.delete']) {
    assert.equal(runtimeOperationEffect(operation), 'mutate', operation);
    assert.equal(isMutationToolCall(runtimeCall(operation), p), true, operation);
  }

  assert.equal(runtimeOperationEffect('state.set'), 'mutate');
  assert.equal(isMutationToolCall(runtimeCall('state.set'), p), true);
  assert.equal(runtimeOperationEffect('future.unknown'), undefined);
  assert.equal(isMutationToolCall(runtimeCall('future.unknown'), p), false);
});

test('process.run is classified from the actual command rather than the operation name', () => {
  const p = runtimeProtocol();
  assert.equal(isExplorationToolCall(runtimeCall('process.run', { command: 'git diff' }), p), true);
  assert.equal(isMutationToolCall(runtimeCall('process.run', { command: 'git diff' }), p), false);
  assert.equal(isExplorationToolCall(runtimeCall('process.run', { command: 'git reset --hard HEAD~1' }), p), false);
  assert.equal(isMutationToolCall(runtimeCall('process.run', { command: 'git reset --hard HEAD~1' }), p), true);
});

test('shell descriptions never override command classification', () => {
  for (const name of ['Bash', 'functions.exec_command']) {
    const p = buildToolProtocolPlan({ tools: [{ type: 'function', function: {
      name, description: 'Read, search, create and edit files using shell commands'
    } }] });
    assert.equal(isExplorationToolCall(call(name, { cmd: 'rtk rg pattern src' }), p), true);
    for (const cmd of ['ls\nprintf unsafe', 'find . -delete', 'find . -exec echo {} +', 'git branch new', 'git diff --output=patch', 'rg --pre=script pattern']) {
      assert.equal(isExplorationToolCall(call(name, { cmd }), p), false, cmd);
    }
  }
});

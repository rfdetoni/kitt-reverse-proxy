import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ToolEnforcementError,
  buildToolEnforcementDirective,
  buildToolEnforcementPlan,
  buildToolEnforcementRetryPrompt
} from '../src/runtime/tool-enforcement.js';
import { buildToolProtocolPlan } from '../src/mapping/tool-calling.js';

function protocol() {
  return buildToolProtocolPlan({
    tools: [
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
      }
    ]
  });
}

test('mutation directive requires generated code inside tool arguments', () => {
  const enforcement = buildToolEnforcementPlan(
    protocol(),
    'crie um arquivo src/index.ts com a implementação',
    'explore-first'
  );

  const directive = buildToolEnforcementDirective(enforcement, true, true, false);

  assert.match(directive, /file body intended for the workspace MUST be inside the mutation tool call arguments/i);
  assert.match(directive, /target path and complete file content/i);
  assert.match(directive, /Do NOT print file contents as prose or Markdown code fences/i);
  assert.match(directive, /Return only the mutation tool call now/i);
});

test('mutation retry explicitly converts text-only code into a tool payload', () => {
  const enforcement = buildToolEnforcementPlan(
    protocol(),
    'crie um arquivo src/index.ts com a implementação',
    'explore-first'
  );
  const error = new ToolEnforcementError(
    'mutation required',
    'mutation_required'
  );

  const retry = buildToolEnforcementRetryPrompt(enforcement, error);

  assert.match(retry, /generated file body or code change inside the arguments/i);
  assert.match(retry, /path plus complete content/i);
  assert.match(retry, /Do not emit the file contents as assistant text or Markdown/i);
});

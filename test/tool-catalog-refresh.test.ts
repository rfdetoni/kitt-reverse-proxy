import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildToolProtocolPlan, formatApiDirective } from '../src/mapping/tool-calling.js';

test('API directive exposes every available function with its argument schema', () => {
  const plan = buildToolProtocolPlan({
    tools: [
      {
        type: 'function',
        function: {
          name: 'repo_read',
          description: 'Read a repository file',
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
          name: 'repo_write',
          description: 'Write a repository file',
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

  const directive = formatApiDirective(plan);
  assert.match(directive, /"name":"repo_read"/);
  assert.match(directive, /"name":"repo_write"/);
  assert.match(directive, /"required":\["path"\]/);
  assert.match(directive, /"required":\["path","content"\]/);
});

test('UI executor refreshes the complete tool directive on every tool-enabled request', () => {
  const source = readFileSync(new URL('../../src/runtime/ui-executor.ts', import.meta.url), 'utf8');

  assert.match(
    source,
    /let prefix = protocolEnabled\s*\? formatApiDirective\(plan\)/,
    'tool-enabled turns must always prepend the complete API tool directive'
  );
  assert.doesNotMatch(
    source,
    /protocolEnabled && protocolFingerprint === this\.protocolFingerprint/,
    'unchanged tool fingerprints must not downgrade to a generic reminder'
  );
});

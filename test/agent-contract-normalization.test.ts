import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentContractValidationError,
  prepareAgentContractRequest,
  transformAgentContractCompletion
} from '../src/runtime/agent-contract.js';
import type { JsonObject, OpenAiCompletion } from '../src/types.js';

function completion(content: string): OpenAiCompletion {
  return {
    id: 'agent-contract-normalization-test',
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

function body(route: string): JsonObject {
  return {
    model: 'chatgpt-web',
    messages: [
      {
        role: 'developer',
        content: `[KITT TURN CONTEXT]\n${JSON.stringify({
          route,
          workspace_context: { files: ['README.md'] }
        })}`
      },
      { role: 'user', content: 'Validate the current workspace.' }
    ]
  };
}

function finalContract(content = 'ok'): string {
  return JSON.stringify({
    action: 'final_response',
    tool: null,
    tool_input: null,
    content,
    reasoning_summary: 'Validação concluída.'
  });
}

test('recovers a single contract object wrapped in markdown or prose', () => {
  const plan = prepareAgentContractRequest(body('code-edit'), { sessionId: 'normalize-wrapped' });

  const fenced = transformAgentContractCompletion(
    completion(`\`\`\`json\n${finalContract('fenced')}\n\`\`\``),
    plan
  );
  assert.equal(fenced.choices[0]?.message.content, 'fenced');

  const prose = transformAgentContractCompletion(
    completion(`Resultado do contrato:\n${finalContract('prose')}\nFim.`),
    plan
  );
  assert.equal(prose.choices[0]?.message.content, 'prose');
});

test('validate-diff turns plain final prose into a final response instead of HTTP 502', () => {
  const plan = prepareAgentContractRequest(body('validate-diff'), { sessionId: 'normalize-validate-diff' });
  const result = transformAgentContractCompletion(
    completion('Validação concluída. Nenhuma inconsistência adicional encontrada.'),
    plan
  );

  assert.equal(
    result.choices[0]?.message.content,
    'Validação concluída. Nenhuma inconsistência adicional encontrada.'
  );
  assert.equal(result.choices[0]?.finish_reason, 'stop');
});

test('validate-diff does not downgrade malformed contract intent to text fallback', () => {
  const plan = prepareAgentContractRequest(body('validate-diff'), { sessionId: 'normalize-malformed-contract' });
  assert.throws(
    () => transformAgentContractCompletion(
      completion('{"action":"use_tool","tool":"kitt_runtime","tool_input":{"operation":"process.run","arguments":{"command":"echo broken"}}'),
      plan
    ),
    AgentContractValidationError
  );
});

test('mutation routes keep rejecting unstructured prose', () => {
  const plan = prepareAgentContractRequest(body('code-edit'), { sessionId: 'normalize-mutation-strict' });
  assert.throws(
    () => transformAgentContractCompletion(completion('Alteração concluída.'), plan),
    AgentContractValidationError
  );
});

test('rejects ambiguous responses containing multiple contract objects', () => {
  const plan = prepareAgentContractRequest(body('validate-diff'), { sessionId: 'normalize-ambiguous' });
  assert.throws(
    () => transformAgentContractCompletion(
      completion(`${finalContract('one')}\n${finalContract('two')}`),
      plan
    ),
    AgentContractValidationError
  );
});

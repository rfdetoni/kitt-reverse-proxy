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

function bodyWithRuntimeTool(route: string): JsonObject {
  const source = body(route);
  source.tools = [{
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
  }];
  return source;
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

test('repairs literal newlines inside contract string values locally', () => {
  const plan = prepareAgentContractRequest(body('validate-diff'), { sessionId: 'normalize-literal-newline' });
  const malformed = [
    '{',
    '"action":"final_response",',
    '"tool":null,',
    '"tool_input":null,',
    '"content":"linha 1',
    'linha 2",',
    '"reasoning_summary":"ok"',
    '}'
  ].join('\n');

  const result = transformAgentContractCompletion(completion(malformed), plan);
  assert.equal(result.choices[0]?.message.content, 'linha 1\nlinha 2');
});

test('normalizes a bare safe-runtime operation into kitt_runtime tool call', () => {
  const plan = prepareAgentContractRequest(
    bodyWithRuntimeTool('code-generation'),
    { sessionId: 'normalize-bare-runtime-operation' }
  );
  const result = transformAgentContractCompletion(
    completion(JSON.stringify({
      operation: 'repo.read',
      arguments: { path: 'backend/build.gradle' }
    })),
    plan
  );

  const call = result.choices[0]?.message.tool_calls?.[0];
  assert.equal(call?.function.name, 'kitt_runtime');
  const args = JSON.parse(call?.function.arguments || '{}');
  assert.equal(args.operation, 'repo.read');
  assert.equal(args.arguments.path, 'backend/build.gradle');
});

test('normalizes a kitt tool envelope into the contract tool call', () => {
  const plan = prepareAgentContractRequest(
    bodyWithRuntimeTool('code-generation'),
    { sessionId: 'normalize-kitt-envelope' }
  );
  const source = [
    '<kitt-tool>',
    '{',
    '"id":"call_1",',
    '"name":"kitt_runtime",',
    '"arguments":{',
    '  "operation":"repo.write_file",',
    '  "arguments":{',
    '    "path":"frontend/src/app/app.component.ts",',
    '    "content":"import { Component } from \'@angular/core\';',
    '',
    '@Component({',
    '  selector: "app-root",',
    '  template: "<h1>MeuFazTudo</h1>"',
    '})',
    'export class AppComponent {}"',
    '  }',
    '}',
    '}',
    '</kitt-tool>'
  ].join('\n');

  const result = transformAgentContractCompletion(completion(source), plan);
  const call = result.choices[0]?.message.tool_calls?.[0];
  assert.equal(call?.function.name, 'kitt_runtime');
  const args = JSON.parse(call?.function.arguments || '{}');
  assert.equal(args.operation, 'repo.write_file');
  assert.equal(args.arguments.path, 'frontend/src/app/app.component.ts');
  assert.match(args.arguments.content, /selector: "app-root"/);
  assert.match(args.arguments.content, /MeuFazTudo/);
});

test('preserves markdown-sensitive XML and CSS bytes inside fenced write-file contracts', () => {
  const plan = prepareAgentContractRequest(
    bodyWithRuntimeTool('code-generation'),
    { sessionId: 'normalize-webchat-markup-safe' }
  );
  const xml = '<project>\n  <modelVersion>4.0.0</modelVersion>\n</project>\n';
  const css = '/* reset */\n* { box-sizing: border-box; }\n';
  for (const [path, fileContent] of [
    ['backend/pom.xml', xml],
    ['frontend/src/styles.css', css]
  ]) {
    const source = `\`\`\`json\n${JSON.stringify({
      action: 'use_tool',
      tool: 'kitt_runtime',
      tool_input: {
        operation: 'repo.write_file',
        arguments: { path, content: fileContent }
      },
      content: null,
      reasoning_summary: 'Write exact file bytes.'
    })}\n\`\`\``;
    const result = transformAgentContractCompletion(completion(source), plan);
    const call = result.choices[0]?.message.tool_calls?.[0];
    const args = JSON.parse(call?.function.arguments || '{}');
    assert.equal(args.arguments.path, path);
    assert.equal(args.arguments.content, fileContent);
  }
});

test('recovers malformed repo.write_file contract when file JSON quotes are not escaped', () => {
  const plan = prepareAgentContractRequest(
    bodyWithRuntimeTool('code-generation'),
    { sessionId: 'normalize-write-file-json-content' }
  );
  const source = '{"action":"use_tool","tool":"kitt_runtime","tool_input":{"operation":"repo.write_file","arguments":{"path":"frontend/angular.json","content":"{\\n "$schema": "./node_modules/@angular/cli/lib/config/schema.json",\\n "version": 1,\\n "projects": {"meufaztudo-frontend": {"projectType": "application"}}\\n}\\n"}},"content":null,"reasoning_summary":"Configuração Angular criada."}';

  const result = transformAgentContractCompletion(completion(source), plan);
  const call = result.choices[0]?.message.tool_calls?.[0];
  assert.equal(call?.function.name, 'kitt_runtime');

  const args = JSON.parse(call?.function.arguments || '{}');
  assert.equal(args.operation, 'repo.write_file');
  assert.equal(args.arguments.path, 'frontend/angular.json');
  assert.equal(
    args.arguments.content,
    '{\n "$schema": "./node_modules/@angular/cli/lib/config/schema.json",\n "version": 1,\n "projects": {"meufaztudo-frontend": {"projectType": "application"}}\n}\n'
  );
});

test('structurally malformed non-write contract remains fail-closed', () => {
  const plan = prepareAgentContractRequest(
    bodyWithRuntimeTool('code-generation'),
    { sessionId: 'normalize-non-write-malformed' }
  );
  const source = '{"action":"use_tool","tool":"kitt_runtime","tool_input":{"operation":"repo.read","arguments":{"path":"a.txt"}}';

  assert.throws(
    () => transformAgentContractCompletion(completion(source), plan),
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

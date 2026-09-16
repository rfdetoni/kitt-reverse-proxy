import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentContractValidationError,
  prepareAgentContractRequest,
  transformAgentContractCompletion
} from '../src/runtime/agent-contract.js';
import type { JsonObject, OpenAiCompletion } from '../src/types.js';

function summaryBody(): JsonObject {
  return {
    model: 'gemini-web',
    messages: [
      { role: 'system', content: 'Prepare a short technical context for another model to answer the task.' },
      {
        role: 'developer',
        content: `[KITT TURN CONTEXT]\n${JSON.stringify({ route: 'summarize', workspace_context: { files: ['README.md'] } })}`
      },
      { role: 'user', content: 'Task: create backend and frontend\n\nProject map: README.md' }
    ],
    tools: [{
      type: 'function',
      function: {
        name: 'kitt_runtime',
        description: 'Execute workspace operations.',
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

function completion(content: string): OpenAiCompletion {
  return {
    id: 'summary-isolation-test',
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

test('summarize advertises final-response-only behavior and no tools', () => {
  const plan = prepareAgentContractRequest(summaryBody(), { sessionId: 'summaryIsolation' });
  const messages = plan.body.messages as Array<{ role?: string; content?: string }>;
  const developer = messages.find((message) => message.role === 'developer')?.content ?? '';

  assert.equal(plan.route, 'summarize');
  assert.equal(plan.tools.size, 0);
  assert.match(developer, /ROUTE_INSTRUCTION: This turn is context-summary only/);
  assert.match(developer, /Do not use or request tools/);
  assert.match(developer, /Return action="final_response"/);
  assert.match(developer, /TOOLS_AVAILABLE: \[\]/);
});

test('summarize rejects request_tools before it can become an orchestration error', () => {
  const plan = prepareAgentContractRequest(summaryBody(), { sessionId: 'summaryRequestTools' });

  assert.throws(
    () => transformAgentContractCompletion(completion(JSON.stringify({
      action: 'request_tools',
      tool: null,
      tool_input: null,
      content: 'Preciso das tools para continuar.',
      reasoning_summary: 'Vou solicitar tools.'
    })), plan),
    (error: unknown) => error instanceof AgentContractValidationError && /summarize exige action=final_response/.test(error.message)
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';

import { createOpenAiRouter } from '../src/proxy/openai-router.js';
import type { SessionExecutionLease, SessionManager } from '../src/runtime/session-manager.js';
import type { ChatExecutionOptions, ChatExecutionResult, JsonObject } from '../src/types.js';

function result(content: string): ChatExecutionResult {
  return {
    completion: {
      id: 'contract-repair',
      object: 'chat.completion',
      created: 1,
      model: 'chatgpt-web',
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop'
      }]
    },
    deltas: []
  };
}

test('contract repair keeps the same session lease and original task context', async () => {
  const executedBodies: JsonObject[] = [];
  let transactionCalls = 0;
  const lease: SessionExecutionLease = {
    sessionId: 'stable-session',
    contextKey: 'test:stable-session:1',
    generation: 1,
    async execute(body: JsonObject): Promise<ChatExecutionResult> {
      executedBodies.push(body);
      if (executedBodies.length === 1) return result('not valid contract json');
      return result(JSON.stringify({
        action: 'final_response',
        tool: null,
        tool_input: null,
        content: 'recovered',
        reasoning_summary: '',
        loop: null
      }));
    }
  };
  const manager = {
    transport: 'ui',
    modelId: 'chatgpt-web',
    normalizeSessionId(value: string | undefined): string {
      return value || 'default';
    },
    async transaction(
      requestedId: string | undefined,
      _options: ChatExecutionOptions,
      operation: (current: SessionExecutionLease) => Promise<ChatExecutionResult>
    ): Promise<ChatExecutionResult> {
      transactionCalls += 1;
      assert.equal(requestedId, 'stable-session');
      return await operation(lease);
    }
  } as unknown as SessionManager;

  const app = express();
  app.use(express.json());
  app.use(createOpenAiRouter(manager));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-kitt-agent-contract': 'v2',
          'x-kitt-route': 'chat',
          'x-kitt-session-id': 'stable-session'
        },
        body: JSON.stringify({
          model: 'chatgpt-web',
          messages: [{ role: 'user', content: 'keep this task context' }]
        })
      }
    );
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    assert.equal(payload.choices?.[0]?.message?.content, 'recovered');
    assert.equal(transactionCalls, 1);
    assert.equal(executedBodies.length, 2);

    const repairMessages = JSON.stringify(executedBodies[1]?.messages ?? []);
    assert.match(repairMessages, /KITT CONTRACT REPAIR/);
    assert.match(repairMessages, /keep this task context/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, got {count}")
    return text.replace(old, new, 1)


monitor = Path("src/runtime/ui-response-monitor.ts")
text = monitor.read_text(encoding="utf-8")
text = replace_once(
    text,
    "export interface UiResponseResult {\n  text: string;\n  deltas: string[];\n}",
    "export interface UiResponseResult {\n  text: string;\n  deltas: string[];\n  firstDeltaMs?: number;\n  durationMs: number;\n}",
    "UiResponseResult",
)
text = replace_once(
    text,
    "  const deadline = Date.now() + config.uiResponseTimeoutMs;\n  const deltas: string[] = [];\n",
    "  const startedAt = Date.now();\n  const deadline = startedAt + config.uiResponseTimeoutMs;\n  const deltas: string[] = [];\n  let firstDeltaMs: number | undefined;\n",
    "response timer",
)
text = replace_once(
    text,
    "        if (delta) {\n          streamedText = active.text.trim();\n",
    "        if (delta) {\n          if (firstDeltaMs === undefined) firstDeltaMs = Math.max(0, Date.now() - startedAt);\n          streamedText = active.text.trim();\n",
    "first delta timer",
)
old_return = "return { text: lastText, deltas };"
if text.count(old_return) != 2:
    raise RuntimeError(f"response returns: expected two matches, got {text.count(old_return)}")
text = text.replace(
    old_return,
    "return { text: lastText, deltas, firstDeltaMs, durationMs: Math.max(0, Date.now() - startedAt) };",
)
monitor.write_text(text, encoding="utf-8")


executor = Path("src/runtime/ui-executor.ts")
text = executor.read_text(encoding="utf-8")
text = replace_once(
    text,
    "  ): Promise<{ text: string; deltas?: string[]; snapshots?: string[] }> {\n",
    "  ): Promise<{ text: string; deltas?: string[]; snapshots?: string[]; firstDeltaMs?: number; durationMs: number }> {\n",
    "awaitResponse type",
)
text = replace_once(
    text,
    "  async execute(body: JsonObject, options?: ChatExecutionOptions): Promise<ChatExecutionResult> {\n    throwIfAborted(options?.signal);\n",
    "  async execute(body: JsonObject, options?: ChatExecutionOptions): Promise<ChatExecutionResult> {\n    const executionStartedAt = Date.now();\n    throwIfAborted(options?.signal);\n",
    "executor start",
)
text = replace_once(
    text,
    "    const artifactBaseline = await extractArtifactContents(this.session.page).catch(() => []);\n    const baseline = await collectVisibleSnapshots(this.session.page, this.provider.ui.responseSelectors);\n    await this.sendPrompt(prompt, options?.signal);\n\n    const bufferResponse = requestMayReturnToolCalls(body) || Boolean(structured);\n",
    "    const artifactBaseline = await extractArtifactContents(this.session.page).catch(() => []);\n    const baseline = await collectVisibleSnapshots(this.session.page, this.provider.ui.responseSelectors);\n    const promptSendStartedAt = Date.now();\n    await this.sendPrompt(prompt, options?.signal);\n    const promptSentAt = Date.now();\n\n    const bufferResponse = requestMayReturnToolCalls(body) || Boolean(structured);\n",
    "prompt send timing",
)
text = replace_once(
    text,
    "    const execution: ChatExecutionResult = {\n      completion: output,\n      deltas,\n      ...(structuredOutputFailed ? { metadata: { structured_output: 'failed' } } : {})\n    };\n",
    "    const timing: JsonObject = {\n      transport: 'ui',\n      ui_prepare_ms: Math.max(0, promptSendStartedAt - executionStartedAt),\n      ui_prompt_send_ms: Math.max(0, promptSentAt - promptSendStartedAt),\n      ui_response_ttft_ms: result.firstDeltaMs ?? result.durationMs,\n      ui_response_wait_ms: result.durationMs,\n      ui_executor_total_ms: Math.max(0, Date.now() - executionStartedAt)\n    };\n    const execution: ChatExecutionResult = {\n      completion: output,\n      deltas,\n      metadata: {\n        ...(structuredOutputFailed ? { structured_output: 'failed' } : {}),\n        timing\n      }\n    };\n",
    "executor timing metadata",
)
executor.write_text(text, encoding="utf-8")


manager = Path("src/runtime/session-manager.ts")
text = manager.read_text(encoding="utf-8")
text = replace_once(
    text,
    "import { SerialQueue } from './serial-queue.js';\nimport { telemetry } from '../util/telemetry.js';\n",
    "import { SerialQueue } from './serial-queue.js';\nimport { logger } from '../logger.js';\nimport { telemetry } from '../util/telemetry.js';\n",
    "logger import",
)
old_execute = """  async execute(requestedId: string | undefined, body: JsonObject, options?: ChatExecutionOptions): Promise<ChatExecutionResult> {
    const session = await this.resolve(requestedId);
    updateRequestContext({ sessionId: session.id, provider: session.provider });
    session.lastActivity = Date.now();
    const queuedAt = Date.now();
    return session.queue.run(async () => {
      telemetry.recordQueueWait(session.provider, Date.now() - queuedAt);
      session.status = 'busy';
      session.lastActivity = Date.now();
      try {
        return await session.executor.execute(body, options);
      } finally {
        session.lastActivity = Date.now();
        session.status = 'idle';
      }
    }, options?.signal);
  }
"""
new_execute = """  async execute(requestedId: string | undefined, body: JsonObject, options?: ChatExecutionOptions): Promise<ChatExecutionResult> {
    const requestStartedAt = Date.now();
    const session = await this.resolve(requestedId);
    const resolvedAt = Date.now();
    updateRequestContext({ sessionId: session.id, provider: session.provider });
    session.lastActivity = Date.now();
    const queuedAt = Date.now();
    return session.queue.run(async () => {
      const dequeuedAt = Date.now();
      const queueWaitMs = Math.max(0, dequeuedAt - queuedAt);
      telemetry.recordQueueWait(session.provider, queueWaitMs);
      session.status = 'busy';
      session.lastActivity = Date.now();
      const executorStartedAt = Date.now();
      try {
        const result = await session.executor.execute(body, options);
        const completedAt = Date.now();
        const timing: JsonObject = {
          session_resolve_ms: Math.max(0, resolvedAt - requestStartedAt),
          queue_wait_ms: queueWaitMs,
          executor_ms: Math.max(0, completedAt - executorStartedAt),
          total_ms: Math.max(0, completedAt - requestStartedAt),
          transport: session.executor.transport,
          ...(result.metadata?.timing !== undefined ? { executor_timing: result.metadata.timing } : {})
        };
        logger.event('info', 'chat.timing', timing);
        return { ...result, metadata: { ...(result.metadata ?? {}), timing } };
      } catch (error) {
        const failedAt = Date.now();
        logger.event('warn', 'chat.timing', {
          session_resolve_ms: Math.max(0, resolvedAt - requestStartedAt),
          queue_wait_ms: queueWaitMs,
          executor_ms: Math.max(0, failedAt - executorStartedAt),
          total_ms: Math.max(0, failedAt - requestStartedAt),
          transport: session.executor.transport,
          outcome: 'error'
        });
        throw error;
      } finally {
        session.lastActivity = Date.now();
        session.status = 'idle';
      }
    }, options?.signal);
  }
"""
text = replace_once(text, old_execute, new_execute, "session execute timing")
manager.write_text(text, encoding="utf-8")


tests = Path("test/session-manager.test.ts")
text = tests.read_text(encoding="utf-8")
if "session manager attaches per-request timing metadata" not in text:
    text += """

test('session manager attaches per-request timing metadata', async () => {
  const manager = new SessionManager({
    defaultExecutor: executor('default'),
    provider: 'chatgpt',
    config
  });
  try {
    const result = await manager.execute(undefined, { messages: [{ role: 'user', content: 'timing' }] });
    const timing = result.metadata?.timing as JsonObject | undefined;
    assert.ok(timing);
    assert.equal(timing.transport, 'ui');
    for (const key of ['session_resolve_ms', 'queue_wait_ms', 'executor_ms', 'total_ms']) {
      assert.equal(typeof timing[key], 'number');
      assert.ok((timing[key] as number) >= 0);
    }
  } finally {
    await manager.close();
  }
});
"""
tests.write_text(text, encoding="utf-8")

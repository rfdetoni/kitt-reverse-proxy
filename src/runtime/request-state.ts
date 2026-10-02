import { randomUUID } from 'node:crypto';
import type { JsonObject } from '../types.js';
import { estimateTokenCount } from '../proxy/token-usage.js';
import { throwIfAborted } from './cancellation.js';
export class RequestDeadlineError extends Error {
  constructor() { super('The end-to-end request deadline was exceeded.'); this.name = 'RequestDeadlineError'; }
}
export class AttemptBudgetError extends Error {
  constructor() { super('The authorized upstream attempt/prompt budget was exhausted.'); this.name = 'AttemptBudgetError'; }
}
export class ProviderRequestState {
  readonly requestId: string;
  readonly startedAt = Date.now();
  readonly deadline: number;
  readonly signal: AbortSignal;
  readonly maxAttempts: number;
  readonly maxPromptTokens: number;
  phase: 'queued' | 'submitted' | 'receiving' | 'completed' | 'failed' | 'outcome_unknown' = 'queued';
  attempts = 0;
  promptTokens = 0;
  completionTokens = 0;
  submitted = false;
  private readonly timer: NodeJS.Timeout;
  private readonly controller = new AbortController();
  constructor(input: { requestId?: string; signal?: AbortSignal; timeoutMs?: number; maxAttempts?: number; maxPromptTokens?: number } = {}) {
    this.requestId = input.requestId ?? randomUUID();
    this.deadline = this.startedAt + Math.max(1, Math.min(900_000, input.timeoutMs ?? 240_000));
    this.maxAttempts = Math.max(1, Math.min(3, input.maxAttempts ?? 3));
    this.maxPromptTokens = Math.max(1, Math.min(1_000_000, input.maxPromptTokens ?? 1_000_000));
    this.signal = input.signal ? AbortSignal.any([input.signal, this.controller.signal]) : this.controller.signal;
    this.timer = setTimeout(() => this.controller.abort(new RequestDeadlineError()), Math.max(1, this.deadline - Date.now()));
    this.timer.unref();
  }
  beforeSubmit(prompt: string): void {
    if (Date.now() >= this.deadline) throw new RequestDeadlineError();
    throwIfAborted(this.signal);
    const tokens = estimateTokenCount(prompt);
    if (this.attempts >= this.maxAttempts || this.promptTokens + tokens > this.maxPromptTokens) throw new AttemptBudgetError();
    this.attempts += 1; this.promptTokens += tokens; this.submitted = true; this.phase = 'submitted';
  }
  received(text: string): void { this.completionTokens += estimateTokenCount(text); this.phase = 'receiving'; }
  usage(replay = false): JsonObject {
    return { prompt_tokens: replay ? 0 : this.promptTokens, completion_tokens: replay ? 0 : this.completionTokens,
      total_tokens: replay ? 0 : this.promptTokens + this.completionTokens, upstream_attempts: replay ? 0 : this.attempts,
      kitt_estimated: true, kitt_replay: replay };
  }
  dispose(): void { clearTimeout(this.timer); }
}

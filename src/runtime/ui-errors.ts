export class ManualInterventionRequiredError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'ManualInterventionRequiredError';
  }
}

export class UiAutomationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UiAutomationError';
  }
}

export class UiTimeoutError extends UiAutomationError {
  constructor(message: string) {
    super(message);
    this.name = 'UiTimeoutError';
  }
}

/** Submitted WebChat turn was not attributable to a current assistant answer.
 * Caller may CONTINUE manually, but must never replay a possibly sent prompt. */
export class UiUncorrelatedCaptureError extends UiTimeoutError {
  constructor(message: string) {
    super(message);
    this.name = 'UiUncorrelatedCaptureError';
  }
}

export class ConversationStateConflictError extends Error {
  constructor() {
    super('O histórico recebido pertence a outra conversa. Use /v1/kitt/reset ou uma sessão dedicada.');
    this.name = 'ConversationStateConflictError';
  }
}

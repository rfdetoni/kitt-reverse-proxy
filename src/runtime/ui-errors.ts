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

export class ConversationStateConflictError extends Error {
  constructor() {
    super('O histórico recebido pertence a outra conversa. Use /v1/kitt/reset ou uma sessão dedicada.');
    this.name = 'ConversationStateConflictError';
  }
}

/** Shared typed decoder failure, free of parser import cycles. */
export class KAPError extends Error {
  readonly code?: string;
  readonly line?: number;
  constructor(message: string, code?: string, line?: number) {
    super(message);
    this.name = 'KAPError';
    this.code = code;
    this.line = line;
  }
}

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
  sessionId: string;
  provider: string;
  startedAt: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, callback: () => T): T {
  return storage.run(context, callback);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function updateRequestContext(update: Partial<Pick<RequestContext, 'sessionId' | 'provider'>>): void {
  const current = storage.getStore();
  if (!current) return;
  if (update.sessionId !== undefined) current.sessionId = update.sessionId;
  if (update.provider !== undefined) current.provider = update.provider;
}

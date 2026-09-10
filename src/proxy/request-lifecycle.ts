import type { Request, Response } from 'express';

export interface RequestLifecycle {
  signal: AbortSignal;
  dispose(): void;
}

export function requestLifecycle(req: Request, res: Response): RequestLifecycle {
  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort();
  };
  const onResponseClose = (): void => {
    if (!res.writableEnded) abort();
  };

  req.once('aborted', abort);
  res.once('close', onResponseClose);

  return {
    signal: controller.signal,
    dispose(): void {
      req.removeListener('aborted', abort);
      res.removeListener('close', onResponseClose);
    }
  };
}

export async function withRequestLifecycle<T>(
  req: Request,
  res: Response,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const lifecycle = requestLifecycle(req, res);
  try {
    return await operation(lifecycle.signal);
  } finally {
    lifecycle.dispose();
  }
}

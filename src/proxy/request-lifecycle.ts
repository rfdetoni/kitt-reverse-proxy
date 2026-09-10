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
  const onClose = (): void => {
    if (!res.writableEnded) abort();
  };

  req.once('aborted', abort);
  req.once('close', onClose);
  res.once('close', onClose);

  return {
    signal: controller.signal,
    dispose(): void {
      req.removeListener('aborted', abort);
      req.removeListener('close', onClose);
      res.removeListener('close', onClose);
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

import type { APIResponse, BrowserContext } from 'playwright';
import { RESOURCE_LIMITS, utf8Bytes } from '../core/resource-limits.js';
import { decodeRequestBody, encodeRequestBody } from '../discovery/body-codec.js';
import { decodeTextBody } from '../discovery/decoder.js';
import { mergeRotatingHeaders } from '../security/headers.js';
import type { JsonObject, JsonValue, RequestBodyCodecDescriptor, UpstreamResult } from '../types.js';
import { RequestAbortedError } from './serial-queue.js';

const MAX_REDIRECTS = 5;

export class UpstreamHttpError extends Error {
  constructor(public readonly status: number) {
    super(`Chat alvo respondeu HTTP ${status}.`);
    this.name = 'UpstreamHttpError';
  }
}

export class UpstreamRedirectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamRedirectError';
  }
}

export class UpstreamResponseTooLargeError extends Error {
  constructor(public readonly maxBytes = RESOURCE_LIMITS.upstreamResponseBytes) {
    super(`Resposta upstream excede o limite de ${maxBytes} bytes.`);
    this.name = 'UpstreamResponseTooLargeError';
  }
}

function redirectMethod(status: number, method: string): { method: string; keepBody: boolean } {
  if (status === 303 || ((status === 301 || status === 302) && method.toUpperCase() === 'POST')) {
    return { method: 'GET', keepBody: false };
  }
  return { method, keepBody: true };
}

function withoutBodyHeaders(headers: Record<string, string>): Record<string, string> {
  const next = { ...headers };
  delete next['content-type'];
  delete next['content-length'];
  return next;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RequestAbortedError();
}

async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await promise;
  throwIfAborted(signal);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new RequestAbortedError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export class BrowserUpstreamClient {
  private headers: Record<string, string>;
  private readonly initialOrigin: string;

  constructor(
    private readonly context: BrowserContext,
    private readonly endpointUrl: string,
    capturedHeaders: Record<string, string>,
    private readonly codec: RequestBodyCodecDescriptor,
    private readonly timeoutMs: number,
    private readonly followRedirects = false
  ) {
    this.headers = { ...capturedHeaders };
    this.initialOrigin = new URL(endpointUrl).origin;
    if (codec.kind === 'form' && !this.headers['content-type']) {
      this.headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    }
  }

  private async fetchOnce(
    url: string,
    method: string,
    data: JsonObject | string | undefined,
    headers: Record<string, string>,
    signal?: AbortSignal
  ): Promise<APIResponse> {
    throwIfAborted(signal);
    const request = this.context.request.fetch(url, {
      method,
      headers,
      ...(data === undefined ? {} : { data }),
      timeout: this.timeoutMs,
      failOnStatusCode: false,
      maxRedirects: 0,
      maxRetries: 0
    });
    if (signal) {
      void request.then((response) => {
        if (signal.aborted) void response.dispose().catch(() => undefined);
      }, () => undefined);
    }
    return await withAbort(request, signal);
  }

  async post(body: JsonObject, signal?: AbortSignal): Promise<UpstreamResult> {
    let url = this.endpointUrl;
    let method = 'POST';
    let data: JsonObject | string | undefined = encodeRequestBody(body, this.codec);
    let requestHeaders = { ...this.headers };

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      throwIfAborted(signal);
      const response = await this.fetchOnce(url, method, data, requestHeaders, signal);
      try {
        const status = response.status();
        const headers = response.headers();
        this.headers = mergeRotatingHeaders(this.headers, headers);

        if (status >= 300 && status < 400) {
          const location = headers.location;
          if (!location) throw new UpstreamRedirectError(`Redirect HTTP ${status} sem header Location.`);
          if (!this.followRedirects) throw new UpstreamRedirectError(`Redirect HTTP ${status} bloqueado por configuração.`);
          if (redirects >= MAX_REDIRECTS) throw new UpstreamRedirectError(`Limite de ${MAX_REDIRECTS} redirects upstream excedido.`);

          const nextUrl = new URL(location, url);
          if (nextUrl.origin !== this.initialOrigin) {
            throw new UpstreamRedirectError(`Redirect cross-origin bloqueado: ${nextUrl.origin}.`);
          }
          const transition = redirectMethod(status, method);
          method = transition.method;
          if (!transition.keepBody) {
            data = undefined;
            requestHeaders = withoutBodyHeaders(this.headers);
          } else {
            requestHeaders = data === undefined ? withoutBodyHeaders(this.headers) : { ...this.headers };
          }
          url = nextUrl.toString();
          continue;
        }

        const contentType = headers['content-type'] || '';
        const declaredLength = Number(headers['content-length'] || 0);
        if (Number.isFinite(declaredLength) && declaredLength > RESOURCE_LIMITS.upstreamResponseBytes) {
          throw new UpstreamResponseTooLargeError();
        }
        throwIfAborted(signal);
        const text = await withAbort(response.text(), signal);
        if (utf8Bytes(text) > RESOURCE_LIMITS.upstreamResponseBytes) throw new UpstreamResponseTooLargeError();
        const decoded = decodeTextBody(text, contentType);
        if (status < 200 || status >= 300) throw new UpstreamHttpError(status);
        return { status, headers, contentType, body: decoded };
      } finally {
        await response.dispose().catch(() => undefined);
      }
    }
    throw new UpstreamRedirectError(`Limite de ${MAX_REDIRECTS} redirects upstream excedido.`);
  }
}

export function roundTripCapturedBody(text: string, contentType: string): string | JsonObject | null {
  const decoded = decodeRequestBody(text, contentType);
  return decoded ? encodeRequestBody(decoded.body, decoded.codec) : null;
}

export function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

export function decodeUpstreamBody(text: string, contentType: string): JsonValue {
  return decodeTextBody(text, contentType);
}

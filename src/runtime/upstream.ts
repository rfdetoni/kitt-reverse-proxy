import type { BrowserContext } from 'playwright';
import { decodeRequestBody, encodeRequestBody } from '../discovery/body-codec.js';
import { decodeTextBody } from '../discovery/decoder.js';
import { hasSensitiveForwardHeaders, mergeRotatingHeaders } from '../security/headers.js';
import type { JsonObject, RequestBodyCodecDescriptor, UpstreamResult } from '../types.js';

export class UpstreamHttpError extends Error {
  constructor(public readonly status: number) {
    super(`Chat alvo respondeu HTTP ${status}.`);
    this.name = 'UpstreamHttpError';
  }
}

export class BrowserUpstreamClient {
  private headers: Record<string, string>;

  constructor(
    private readonly context: BrowserContext,
    private readonly endpointUrl: string,
    capturedHeaders: Record<string, string>,
    private readonly codec: RequestBodyCodecDescriptor,
    private readonly timeoutMs: number,
    private readonly followRedirects = false
  ) {
    this.headers = { ...capturedHeaders };
    if (followRedirects && hasSensitiveForwardHeaders(this.headers)) {
      throw new Error('Redirects upstream não podem ser habilitados junto com headers capturados de autenticação/CSRF.');
    }
    if (codec.kind === 'form' && !this.headers['content-type']) {
      this.headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    }
  }

  async post(body: JsonObject): Promise<UpstreamResult> {
    const data = encodeRequestBody(body, this.codec);
    const response = await this.context.request.fetch(this.endpointUrl, {
      method: 'POST',
      headers: this.headers,
      data,
      timeout: this.timeoutMs,
      failOnStatusCode: false,
      maxRedirects: this.followRedirects ? 5 : 0,
      maxRetries: 0
    });

    try {
      const status = response.status();
      const headers = response.headers();
      this.headers = mergeRotatingHeaders(this.headers, headers);
      const contentType = headers['content-type'] || '';
      const text = await response.text();
      const decoded = decodeTextBody(text, contentType);
      if (status < 200 || status >= 300) throw new UpstreamHttpError(status);
      return { status, headers, contentType, body: decoded };
    } finally {
      await response.dispose().catch(() => undefined);
    }
  }
}

// Exported for tests/diagnostics so a captured payload can be verified to round-trip.
export function roundTripCapturedBody(text: string, contentType: string): string | JsonObject | null {
  const decoded = decodeRequestBody(text, contentType);
  return decoded ? encodeRequestBody(decoded.body, decoded.codec) : null;
}

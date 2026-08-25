import type { BrowserContext } from 'playwright';
import type { JsonObject, UpstreamResult } from '../types.js';
import { decodeTextBody } from '../discovery/decoder.js';
import { mergeRotatingHeaders } from '../security/headers.js';

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
    private readonly timeoutMs: number,
    private readonly followRedirects = true
  ) {
    this.headers = { ...capturedHeaders };
  }

  async post(body: JsonObject): Promise<UpstreamResult> {
    const isForm = /application\/x-www-form-urlencoded/i.test(this.headers['content-type'] || '');
    const data = isForm
      ? new URLSearchParams(Object.entries(body).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])).toString()
      : body;

    const response = await this.context.request.fetch(this.endpointUrl, {
      method: 'POST',
      headers: this.headers,
      data,
      timeout: this.timeoutMs,
      failOnStatusCode: false,
      maxRedirects: this.followRedirects ? 5 : 0,
      maxRetries: 0
    });

    const status = response.status();
    const headers = response.headers();
    this.headers = mergeRotatingHeaders(this.headers, headers);
    const contentType = headers['content-type'] || '';
    const text = await response.text();
    const decoded = decodeTextBody(text, contentType);
    await response.dispose();

    if (status < 200 || status >= 300) throw new UpstreamHttpError(status);
    return { status, headers, contentType, body: decoded };
  }
}

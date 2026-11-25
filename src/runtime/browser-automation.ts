import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { browserLaunchOptions } from './browser-session.js';
import { createHash } from 'node:crypto';
import { throwIfAborted } from './cancellation.js';
import type { JsonObject, LiveBrowserSession } from '../types.js';

export const BROWSER_AUTOMATION_ACTIONS = [
  'open',
  'inspect',
  'diagnose',
  'click',
  'type',
  'screenshot',
  'close'
] as const;

export const BROWSER_FILE_ACTIONS = ['upload', 'download'] as const;
export type BrowserAutomationAction = typeof BROWSER_AUTOMATION_ACTIONS[number] | typeof BROWSER_FILE_ACTIONS[number];

const ACTIONS = new Set<string>([...BROWSER_AUTOMATION_ACTIONS, ...BROWSER_FILE_ACTIONS]);
const MAX_UPLOAD_BYTES = 32 * 1024;
const MAX_DOWNLOAD_BYTES = 256 * 1024;
const MAX_SELECTOR_CHARS = 2_048;
const MAX_TEXT_CHARS = 32_768;
const MAX_BODY_CHARS = 20_000;
const MAX_ELEMENT_TEXT_CHARS = 500;
const MAX_ELEMENTS = 100;
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
const MAX_ORIGIN_SCOPE_ENTRIES = 16;
const LOOPBACK_SCOPE = 'loopback';

export class BrowserAutomationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserAutomationInputError';
  }
}

export class BrowserAutomationUnavailableError extends Error {
  constructor(message = 'Browser automation is unavailable for this session.') {
    super(message);
    this.name = 'BrowserAutomationUnavailableError';
  }
}

export class BrowserAutomationTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserAutomationTimeoutError';
  }
}

export class BrowserAutomationExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserAutomationExecutionError';
  }
}

export class BrowserAutomationResponseTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserAutomationResponseTooLargeError';
  }
}

export class BrowserOriginDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserOriginDeniedError';
  }
}

export function normalizeBrowserOriginScope(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return [LOOPBACK_SCOPE];
  if (value.length > MAX_ORIGIN_SCOPE_ENTRIES) {
    throw new BrowserAutomationInputError(
      `Browser origin scope exceeds ${MAX_ORIGIN_SCOPE_ENTRIES} entries.`
    );
  }
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length > 512) {
      throw new BrowserAutomationInputError('Browser origin scope entries must be bounded strings.');
    }
    const raw = item.trim();
    if (!raw) continue;
    if (raw === LOOPBACK_SCOPE) {
      normalized.push(LOOPBACK_SCOPE);
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new BrowserAutomationInputError(`Invalid browser origin scope entry: ${raw}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BrowserAutomationInputError('Browser origin scope only allows http/https origins.');
    }
    if (parsed.username || parsed.password) {
      throw new BrowserAutomationInputError('Browser origin scope must not contain URL credentials.');
    }
    normalized.push(parsed.origin);
  }
  return [...new Set(normalized.length > 0 ? normalized : [LOOPBACK_SCOPE])];
}

function stringArg(
  args: JsonObject,
  key: string,
  options: { required?: boolean; max?: number } = {}
): string {
  const raw = args[key];
  if (raw === undefined || raw === null) {
    if (options.required) throw new BrowserAutomationInputError(`Missing browser argument: ${key}`);
    return '';
  }
  if (typeof raw !== 'string') {
    throw new BrowserAutomationInputError(`Browser argument '${key}' must be a string.`);
  }
  const value = raw.trim();
  if (options.required && !value) {
    throw new BrowserAutomationInputError(`Browser argument '${key}' must not be empty.`);
  }
  if (options.max !== undefined && value.length > options.max) {
    throw new BrowserAutomationInputError(
      `Browser argument '${key}' exceeds ${options.max} characters.`
    );
  }
  return value;
}

function booleanArg(args: JsonObject, key: string, fallback: boolean): boolean {
  const raw = args[key];
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'boolean') {
    throw new BrowserAutomationInputError(`Browser argument '${key}' must be boolean.`);
  }
  return raw;
}

function integerArg(
  args: JsonObject,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = args[key];
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) {
    throw new BrowserAutomationInputError(`Browser argument '${key}' must be an integer.`);
  }
  return Math.max(minimum, Math.min(maximum, raw));
}

function timeoutMs(args: JsonObject): number {
  return integerArg(args, 'timeout_ms', 15_000, 100, 60_000);
}

function httpUrl(args: JsonObject): string {
  const value = stringArg(args, 'url', { required: true, max: 8_192 });
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BrowserAutomationInputError('Browser URL is invalid.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BrowserAutomationInputError('Browser navigation only allows http:// and https:// URLs.');
  }
  if (parsed.username || parsed.password) {
    throw new BrowserAutomationInputError('Browser navigation URLs must not contain credentials.');
  }
  return parsed.href;
}

function selectorArg(args: JsonObject): string {
  return stringArg(args, 'selector', { required: true, max: MAX_SELECTOR_CHARS });
}

function boundedText(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function safeSelectorHint(
  id: string | null,
  name: string | null,
  text: string
): string | undefined {
  if (id && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(id)) return `#${id}`;
  if (name && /^[A-Za-z0-9_.:-]{1,128}$/.test(name)) return `[name="${name}"]`;
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact && compact.length <= 80 && !compact.includes('\n')) return `text=${compact}`;
  return undefined;
}

function safeUrlLabel(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin;
    return parsed.protocol.replace(/:$/, '') || '<blocked>';
  } catch {
    return '<invalid>';
  }
}

function actionName(value: string): BrowserAutomationAction {
  const normalized = String(value || '').trim().toLowerCase();
  if (!ACTIONS.has(normalized)) {
    throw new BrowserAutomationInputError(
      `Unsupported browser action '${value}'. Allowed: ${BROWSER_AUTOMATION_ACTIONS.join(', ')}.`
    );
  }
  return normalized as BrowserAutomationAction;
}

type BrowserDiagnostic = {
  kind: 'console' | 'pageerror' | 'requestfailed' | 'http_error';
  severity: string;
  origin: string;
  fingerprint: string;
  status?: number;
  resource_type?: string;
};

export class BrowserAutomationSession {
  private originScope = new Set<string>([LOOPBACK_SCOPE]);
  private readonly diagnostics: BrowserDiagnostic[] = [];
  private readonly diagnosticCounts = { console: 0, pageerror: 0, requestfailed: 0, http_error: 0 };
  private blockedNavigationUrl: string | undefined;

  private closed = false;

  constructor(
    private readonly page: Page,
    private readonly context: BrowserContext,
    private readonly ownedBrowser?: Browser,
    private readonly fileTransferEnabled = false
  ) {}

  static async create(
    base: LiveBrowserSession,
    originScope: readonly string[] = [LOOPBACK_SCOPE],
    signal?: AbortSignal,
    fileTransferEnabled = false
  ): Promise<BrowserAutomationSession> {
    throwIfAborted(signal);
    // Never expose provider cookies, local storage or IndexedDB to an agent.
    // Reuse the browser process when possible, but always create a clean context.
    let context: BrowserContext | undefined;
    let ownedBrowser: Browser | undefined;
    try {
      if (base.browser?.isConnected()) {
        context = await base.browser.newContext({
          acceptDownloads: false,
          serviceWorkers: 'block'
        }).catch(() => undefined);
      }
      if (!context) {
        const launch = browserLaunchOptions(false);
        ownedBrowser = await chromium.launch({ ...launch, channel: 'chrome' })
          .catch(() => chromium.launch(launch));
        context = await ownedBrowser.newContext({
          acceptDownloads: false,
          serviceWorkers: 'block'
        });
      }
      throwIfAborted(signal);
      const page = await context.newPage();
      throwIfAborted(signal);
      const session = new BrowserAutomationSession(page, context, ownedBrowser, fileTransferEnabled);
      session.setOriginScope(originScope);
      const pageWithRouting = page as Page & {
        route?: Page['route'];
        on?: Page['on'];
      };
      if (fileTransferEnabled) {
        // File-transfer mode is explicitly isolated from cross-origin subresources.
        // Do not allow WebSocket connections or provider context reuse.
        await context.route('**/*', async (route) => {
          const target = route.request().url();
          if (!session.isAllowedUrl(target)) {
            await route.abort('blockedbyclient');
            return;
          }
          await route.continue();
        });
        await context.routeWebSocket('**/*', (socket) => { void socket.close(); });
      } else if (typeof pageWithRouting.route === 'function') {
        await page.route('**/*', async (route) => {
          const request = route.request();
          if (
            request.isNavigationRequest()
            && request.frame() === page.mainFrame()
            && !session.isAllowedUrl(request.url())
          ) {
            session.blockedNavigationUrl = request.url();
            await route.abort('blockedbyclient');
            return;
          }
          await route.continue();
        });
      }
      if (typeof pageWithRouting.on === 'function') {
        page.on('popup', (popup) => {
          void popup.close().catch(() => undefined);
        });
        // Observe real Playwright/CDP events without collecting secrets from
        // console text, requests, headers or response bodies.
        page.on('console', (message) => {
          if (message.type() === 'error' || message.type() === 'warning') {
            session.recordDiagnostic('console', message.type(), page.url(), message.text());
          }
        });
        page.on('pageerror', (error) => {
          session.recordDiagnostic('pageerror', 'error', page.url(), error.message);
        });
        page.on('requestfailed', (request) => {
          session.recordDiagnostic('requestfailed', 'error', request.url(),
            request.failure()?.errorText || 'failed', undefined, request.resourceType());
        });
        page.on('response', (response) => {
          if (response.status() >= 400) {
            session.recordDiagnostic('http_error', 'error', response.url(),
              String(response.status()), response.status(), response.request().resourceType());
          }
        });
      }
      throwIfAborted(signal);
      return session;
    } catch (error) {
      await context?.close().catch(() => undefined);
      await ownedBrowser?.close().catch(() => undefined);
      throw error;
    }
  }

  private recordDiagnostic(
    kind: BrowserDiagnostic['kind'], severity: string, url: string,
    message: string, status?: number, resourceType?: string
  ): void {
    this.diagnosticCounts[kind] += 1;
    const fingerprint = createHash('sha256').update(message).digest('hex').slice(0, 16);
    const entry: BrowserDiagnostic = {
      kind, severity,
      origin: this.isAllowedUrl(url) ? safeUrlLabel(url) : '<outside-scope>',
      fingerprint,
      ...(status !== undefined ? { status } : {}),
      ...(resourceType ? { resource_type: resourceType.slice(0, 32) } : {})
    };
    this.diagnostics.push(entry);
    if (this.diagnostics.length > 128) this.diagnostics.shift();
  }

  private setOriginScope(originScope: readonly string[]): void {
    this.originScope = new Set(normalizeBrowserOriginScope([...originScope]));
    this.blockedNavigationUrl = undefined;
  }

  private isAllowedUrl(value: string): boolean {
    if (value === 'about:blank') return true;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    if (this.originScope.has(parsed.origin)) return true;
    if (!this.originScope.has(LOOPBACK_SCOPE)) return false;
    const hostname = parsed.hostname.toLowerCase();
    return (
      hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname === '127.0.0.1'
      || hostname === '[::1]'
      || hostname === '::1'
    );
  }

  private assertAllowedUrl(value: string): void {
    if (!this.isAllowedUrl(value)) {
      throw new BrowserOriginDeniedError(
        `Browser navigation blocked by origin scope: ${safeUrlLabel(value)}`
      );
    }
  }

  private assertSafeNavigationReference(value: string): void {
    const raw = String(value || '').trim();
    if (!raw || raw.startsWith('#')) return;
    let parsed: URL;
    try {
      parsed = new URL(raw, this.page.url());
    } catch {
      throw new BrowserOriginDeniedError('Browser activation target is invalid.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BrowserOriginDeniedError(
        `Browser activation target uses a blocked URL scheme: ${safeUrlLabel(parsed.href)}`
      );
    }
    if (parsed.username || parsed.password) {
      throw new BrowserOriginDeniedError('Browser activation target must not contain URL credentials.');
    }
    this.assertAllowedUrl(parsed.href);
  }

  private async assertSafeActivationTarget(locator: Locator): Promise<void> {
    const candidates: string[] = [];
    for (const attribute of ['href', 'formaction'] as const) {
      try {
        const value = await locator.getAttribute(attribute);
        if (value) candidates.push(value);
      } catch {
        // Route-level navigation enforcement remains the fail-closed fallback.
      }
    }
    try {
      const form = locator.locator('xpath=ancestor-or-self::form[1]').first();
      if (await form.count() > 0) {
        const action = await form.getAttribute('action');
        if (action) candidates.push(action);
      }
    } catch {
      // Some non-DOM test doubles do not implement ancestor lookup.
    }
    for (const candidate of candidates) this.assertSafeNavigationReference(candidate);
  }

  isClosed(): boolean {
    return this.closed || this.page.isClosed();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.context.close().catch(() => undefined);
    await this.ownedBrowser?.close().catch(() => undefined);
  }

  async execute(
    actionValue: string,
    args: JsonObject = {},
    originScope: readonly string[] = [LOOPBACK_SCOPE],
    signal?: AbortSignal
  ): Promise<JsonObject> {
    throwIfAborted(signal);
    // This tab is dedicated to automation. Closing it interrupts Playwright waits
    // without touching the provider chat tab or undoing already submitted effects.
    const abort = (): void => { void this.close(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      throwIfAborted(signal);
      const result = await this.executeAction(actionValue, args, originScope, signal);
      throwIfAborted(signal);
      return result;
    } catch (error) {
      throwIfAborted(signal);
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  private async executeAction(
    actionValue: string,
    args: JsonObject = {},
    originScope: readonly string[] = [LOOPBACK_SCOPE],
    signal?: AbortSignal
  ): Promise<JsonObject> {
    this.setOriginScope(originScope);
    const action = actionName(actionValue);
    if (action === 'close') {
      await this.close();
      return { action, closed: true };
    }
    if (this.page.isClosed()) {
      throw new BrowserAutomationUnavailableError('Browser automation tab is closed.');
    }

    const timeout = timeoutMs(args);
    if ((action === 'upload' || action === 'download') && !this.fileTransferEnabled) {
      throw new BrowserAutomationUnavailableError('Browser file transfer is disabled by the operator.');
    }
    try {
      if (action === 'upload') {
        this.assertAllowedUrl(this.page.url());
        const selector = selectorArg(args);
        const filename = stringArg(args, 'filename', { required: true, max: 128 });
        if (!/^[A-Za-z0-9][A-Za-z0-9_. -]{0,127}$/.test(filename) || filename.endsWith('.')) {
          throw new BrowserAutomationInputError('Upload filename must be a simple basename.');
        }
        const encoded = stringArg(args, 'data_base64', { required: true, max: Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 });
        const buffer = Buffer.from(encoded, 'base64');
        if (!buffer.length || buffer.length > MAX_UPLOAD_BYTES || buffer.toString('base64') !== encoded) {
          throw new BrowserAutomationInputError('Invalid or oversized upload payload.');
        }
        throwIfAborted(signal);
        await this.page.locator(selector).first().setInputFiles({
          name: filename, mimeType: 'application/octet-stream', buffer
        }, { timeout });
        throwIfAborted(signal);
        this.assertAllowedUrl(this.page.url());
        return { action, filename, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') };
      }
      if (action === 'download') {
        const url = httpUrl(args);
        this.assertAllowedUrl(this.page.url());
        this.assertAllowedUrl(url);
        if (new URL(url).origin !== new URL(this.page.url()).origin) {
          throw new BrowserOriginDeniedError('File download must use the current page origin.');
        }
        const result = await this.page.evaluate(async ({ url, limit, timeout }) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeout);
          try {
            const response = await fetch(url, {
              method: 'GET', credentials: 'same-origin', redirect: 'error',
              cache: 'no-store', signal: controller.signal
            });
            if (!response.ok || !response.body || Number(response.headers.get('content-length') || 0) > limit) {
              throw new Error('Download rejected or exceeds limit.');
            }
            const reader = response.body.getReader();
            const output = new Uint8Array(limit);
            let size = 0;
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              if (size + next.value.byteLength > limit) {
                await reader.cancel();
                throw new Error('Download exceeds limit.');
              }
              output.set(next.value, size);
              size += next.value.byteLength;
            }
            let binary = '';
            for (let offset = 0; offset < size; offset += 8192) {
              binary += String.fromCharCode(...output.subarray(offset, Math.min(size, offset + 8192)));
            }
            return { data: btoa(binary) };
          } finally { clearTimeout(timer); }
        }, { url, limit: MAX_DOWNLOAD_BYTES, timeout });
        throwIfAborted(signal);
        this.assertAllowedUrl(this.page.url());
        if (typeof result.data !== 'string' || result.data.length > Math.ceil(MAX_DOWNLOAD_BYTES / 3) * 4) {
          throw new BrowserAutomationResponseTooLargeError('Download exceeds bounded response.');
        }
        const data = Buffer.from(result.data, 'base64');
        if (data.length > MAX_DOWNLOAD_BYTES || data.toString('base64') !== result.data) {
          throw new BrowserAutomationInputError('Invalid downloaded bytes.');
        }
        return { action, bytes: data.length, data_base64: result.data, sha256: createHash('sha256').update(data).digest('hex') };
      }
      if (action === 'diagnose') {
        this.assertAllowedUrl(this.page.url());
        if (Object.keys(args).length > 0) {
          throw new BrowserAutomationInputError('Browser diagnose accepts no arguments.');
        }
        return {
          action: 'diagnose', url: this.page.url(),
          counters: { ...this.diagnosticCounts },
          recent: this.diagnostics.slice(-32),
          truncated: this.diagnostics.length > 32
        };
      }
      if (action === 'open') {
        const url = httpUrl(args);
        this.assertAllowedUrl(url);
        await this.page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout
        });
        throwIfAborted(signal);
        this.assertAllowedUrl(this.page.url());
        return {
          action,
          url: this.page.url(),
          title: await this.page.title()
        };
      }

      if (action === 'click') {
        this.assertAllowedUrl(this.page.url());
        const selector = selectorArg(args);
        const locator = this.page.locator(selector).first();
        await this.assertSafeActivationTarget(locator);
        throwIfAborted(signal);
        await locator.click({ timeout });
        throwIfAborted(signal);
        this.assertAllowedUrl(this.page.url());
        return {
          action,
          selector,
          url: this.page.url(),
          title: await this.page.title()
        };
      }

      if (action === 'type') {
        this.assertAllowedUrl(this.page.url());
        const selector = selectorArg(args);
        const text = stringArg(args, 'text', { max: MAX_TEXT_CHARS });
        const clear = booleanArg(args, 'clear', true);
        const submit = booleanArg(args, 'submit', false);
        const locator = this.page.locator(selector).first();
        if (submit) await this.assertSafeActivationTarget(locator);
        throwIfAborted(signal);
        if (clear) await locator.fill(text, { timeout });
        else await locator.pressSequentially(text, { timeout });
        throwIfAborted(signal);
        if (submit) await locator.press('Enter', { timeout });
        throwIfAborted(signal);
        this.assertAllowedUrl(this.page.url());
        return {
          action,
          selector,
          submitted: submit,
          text_length: text.length,
          url: this.page.url()
        };
      }

      if (action === 'screenshot') {
        this.assertAllowedUrl(this.page.url());
        const fullPage = booleanArg(args, 'full_page', false);
        const formatRaw = stringArg(args, 'format', { max: 8 }).toLowerCase();
        const format = formatRaw === 'png' ? 'png' : 'jpeg';
        const image = await this.page.screenshot({
          type: format,
          fullPage,
          ...(format === 'jpeg' ? { quality: 70 } : {})
        });
        if (image.byteLength > MAX_SCREENSHOT_BYTES) {
          throw new BrowserAutomationResponseTooLargeError(
            `Browser screenshot exceeds ${MAX_SCREENSHOT_BYTES} bytes.`
          );
        }
        return {
          action,
          format,
          full_page: fullPage,
          bytes: image.byteLength,
          image_base64: image.toString('base64'),
          url: this.page.url(),
          title: await this.page.title()
        };
      }

      this.assertAllowedUrl(this.page.url());
      const snapshot = await this.page.evaluate(
        ({ maxBodyChars, maxElementChars, maxElements }) => {
          const body = document.body?.innerText || '';
          const nodes = document.querySelectorAll<HTMLElement>(
            'a[href],button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]'
          );
          const elements = [];
          for (let index = 0; index < Math.min(nodes.length, maxElements); index += 1) {
            const element = nodes[index]!;
            const compact = (element.innerText || element.textContent || '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, maxElementChars);
            elements.push({
              index,
              text: compact,
              ariaLabel: (element.getAttribute('aria-label') || '').slice(0, maxElementChars),
              placeholder: (element.getAttribute('placeholder') || '').slice(0, maxElementChars),
              href: (element.getAttribute('href') || '').slice(0, 2048),
              name: (element.getAttribute('name') || '').slice(0, 256),
              id: (element.id || '').slice(0, 256),
              type: (element.getAttribute('type') || '').slice(0, 128),
              role: (element.getAttribute('role') || '').slice(0, 128)
            });
          }
          return {
            title: (document.title || '').slice(0, maxElementChars),
            body: body.slice(0, maxBodyChars),
            bodyLength: body.length,
            elements
          };
        },
        {
          maxBodyChars: MAX_BODY_CHARS,
          maxElementChars: MAX_ELEMENT_TEXT_CHARS,
          maxElements: MAX_ELEMENTS
        }
      );
      const elements = snapshot.elements.map((item) => {
        const record: JsonObject = { index: item.index };
        if (item.text) record.text = item.text;
        if (item.ariaLabel) record.aria_label = boundedText(item.ariaLabel, MAX_ELEMENT_TEXT_CHARS);
        if (item.placeholder) record.placeholder = boundedText(item.placeholder, MAX_ELEMENT_TEXT_CHARS);
        if (item.href) record.href = boundedText(item.href, 2_048);
        if (item.name) record.name = boundedText(item.name, 256);
        if (item.type) record.type = boundedText(item.type, 128);
        if (item.role) record.role = boundedText(item.role, 128);
        const hint = safeSelectorHint(item.id, item.name, item.text || item.ariaLabel || '');
        if (hint) record.selector_hint = hint;
        return record;
      });
      return {
        action: 'inspect',
        url: this.page.url(),
        title: snapshot.title,
        text: snapshot.body,
        text_truncated: snapshot.bodyLength > MAX_BODY_CHARS,
        elements,
        element_count: elements.length
      };
    } catch (error) {
      if (
        error instanceof BrowserAutomationInputError ||
        error instanceof BrowserAutomationUnavailableError ||
        error instanceof BrowserAutomationResponseTooLargeError ||
        error instanceof BrowserOriginDeniedError
      ) {
        throw error;
      }
      if (this.blockedNavigationUrl) {
        const blocked = this.blockedNavigationUrl;
        this.blockedNavigationUrl = undefined;
        throw new BrowserOriginDeniedError(
          `Browser navigation blocked by origin scope: ${safeUrlLabel(blocked)}`
        );
      }
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new BrowserAutomationTimeoutError(error.message);
      }
      throw new BrowserAutomationExecutionError(
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}

import type { Locator, Page } from 'playwright';
import type { JsonObject, LiveBrowserSession } from '../types.js';

export const BROWSER_AUTOMATION_ACTIONS = [
  'open',
  'inspect',
  'click',
  'type',
  'screenshot',
  'close'
] as const;

export type BrowserAutomationAction = typeof BROWSER_AUTOMATION_ACTIONS[number];

const ACTIONS = new Set<string>(BROWSER_AUTOMATION_ACTIONS);
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

export class BrowserAutomationSession {
  private originScope = new Set<string>([LOOPBACK_SCOPE]);
  private blockedNavigationUrl: string | undefined;

  constructor(private readonly page: Page) {}

  static async create(
    base: LiveBrowserSession,
    originScope: readonly string[] = [LOOPBACK_SCOPE]
  ): Promise<BrowserAutomationSession> {
    const page = await base.context.newPage();
    const session = new BrowserAutomationSession(page);
    session.setOriginScope(originScope);
    const pageWithRouting = page as Page & {
      route?: Page['route'];
      on?: Page['on'];
    };
    if (typeof pageWithRouting.route === 'function') {
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
    }
    return session;
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
    return this.page.isClosed();
  }

  async close(): Promise<void> {
    await this.page.close().catch(() => undefined);
  }

  async execute(
    actionValue: string,
    args: JsonObject = {},
    originScope: readonly string[] = [LOOPBACK_SCOPE]
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
    try {
      if (action === 'open') {
        const url = httpUrl(args);
        this.assertAllowedUrl(url);
        await this.page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout
        });
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
        await locator.click({ timeout });
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
        if (clear) await locator.fill(text, { timeout });
        else await locator.pressSequentially(text, { timeout });
        if (submit) await locator.press('Enter', { timeout });
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
          const nodes = Array.from(document.querySelectorAll(
            'a[href],button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]'
          )).slice(0, maxElements);
          const elements = nodes.map((node, index) => {
            const element = node as HTMLElement;
            const compact = (element.innerText || element.textContent || '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, maxElementChars);
            return {
              index,
              text: compact,
              ariaLabel: element.getAttribute('aria-label') || '',
              placeholder: element.getAttribute('placeholder') || '',
              href: element.getAttribute('href') || '',
              name: element.getAttribute('name') || '',
              id: element.id || '',
              type: element.getAttribute('type') || '',
              role: element.getAttribute('role') || ''
            };
          });
          return {
            title: document.title || '',
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

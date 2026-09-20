import { TimeoutError as PlaywrightTimeoutError, type Page } from 'playwright';
import type { JsonObject, JsonValue, LiveBrowserSession } from '../types.js';

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
  constructor(private readonly page: Page) {}

  static async create(base: LiveBrowserSession): Promise<BrowserAutomationSession> {
    const page = await base.context.newPage();
    return new BrowserAutomationSession(page);
  }

  isClosed(): boolean {
    return this.page.isClosed();
  }

  async close(): Promise<void> {
    await this.page.close().catch(() => undefined);
  }

  async execute(actionValue: string, args: JsonObject = {}): Promise<JsonObject> {
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
        await this.page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout
        });
        return {
          action,
          url: this.page.url(),
          title: await this.page.title()
        };
      }

      if (action === 'click') {
        const selector = selectorArg(args);
        await this.page.locator(selector).first().click({ timeout });
        return {
          action,
          selector,
          url: this.page.url(),
          title: await this.page.title()
        };
      }

      if (action === 'type') {
        const selector = selectorArg(args);
        const text = stringArg(args, 'text', { max: MAX_TEXT_CHARS });
        const clear = booleanArg(args, 'clear', true);
        const submit = booleanArg(args, 'submit', false);
        const locator = this.page.locator(selector).first();
        if (clear) await locator.fill(text, { timeout });
        else await locator.pressSequentially(text, { timeout });
        if (submit) await locator.press('Enter', { timeout });
        return {
          action,
          selector,
          submitted: submit,
          text_length: text.length,
          url: this.page.url()
        };
      }

      if (action === 'screenshot') {
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

      const body = await this.page.locator('body').innerText({ timeout }).catch(() => '');
      const interactive = this.page.locator(
        'a[href],button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]'
      );
      const count = Math.min(await interactive.count(), MAX_ELEMENTS);
      const elements: JsonValue[] = [];
      for (let index = 0; index < count; index += 1) {
        const item = interactive.nth(index);
        const [text, ariaLabel, placeholder, href, name, id, type, role] = await Promise.all([
          item.innerText({ timeout: Math.min(timeout, 2_000) }).catch(() => ''),
          item.getAttribute('aria-label'),
          item.getAttribute('placeholder'),
          item.getAttribute('href'),
          item.getAttribute('name'),
          item.getAttribute('id'),
          item.getAttribute('type'),
          item.getAttribute('role')
        ]);
        const cleanText = boundedText(text.replace(/\s+/g, ' ').trim(), MAX_ELEMENT_TEXT_CHARS);
        const record: JsonObject = { index };
        if (cleanText) record.text = cleanText;
        if (ariaLabel) record.aria_label = boundedText(ariaLabel, MAX_ELEMENT_TEXT_CHARS);
        if (placeholder) record.placeholder = boundedText(placeholder, MAX_ELEMENT_TEXT_CHARS);
        if (href) record.href = boundedText(href, 2_048);
        if (name) record.name = boundedText(name, 256);
        if (type) record.type = boundedText(type, 128);
        if (role) record.role = boundedText(role, 128);
        const hint = safeSelectorHint(id, name, cleanText || ariaLabel || '');
        if (hint) record.selector_hint = hint;
        elements.push(record);
      }
      return {
        action: 'inspect',
        url: this.page.url(),
        title: await this.page.title(),
        text: boundedText(body, MAX_BODY_CHARS),
        text_truncated: body.length > MAX_BODY_CHARS,
        elements,
        element_count: count
      };
    } catch (error) {
      if (
        error instanceof BrowserAutomationInputError ||
        error instanceof BrowserAutomationUnavailableError ||
        error instanceof BrowserAutomationResponseTooLargeError
      ) {
        throw error;
      }
      if (error instanceof PlaywrightTimeoutError) {
        throw new BrowserAutomationTimeoutError(error.message);
      }
      throw new BrowserAutomationExecutionError(
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}

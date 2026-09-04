import { chmod, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type { AppConfig, LiveBrowserSession } from '../types.js';

function firstUsablePage(context: BrowserContext): Page | undefined {
  return context.pages().find((page: Page) => !page.isClosed());
}

async function prepareUserDataDir(directory: string): Promise<string> {
  const target = resolve(directory);
  await mkdir(target, { recursive: true, mode: 0o700 });
  await chmod(target, 0o700).catch(() => undefined);
  return target;
}

export async function openBrowserSession(config: AppConfig): Promise<LiveBrowserSession> {
  if (config.cdpUrl) {
    const browser = await chromium.connectOverCDP(config.cdpUrl);
    const contexts = browser.contexts();
    const context = contexts[0] ?? await browser.newContext({ acceptDownloads: false });
    let targetHostname = '';
    try {
      targetHostname = new URL(config.targetUrl).hostname;
    } catch {
      // ignore invalid target; validation happens in config
    }
    const matchingPage = targetHostname
      ? context.pages().find((page: Page) => !page.isClosed() && page.url().includes(targetHostname))
      : undefined;
    const page = matchingPage ?? firstUsablePage(context) ?? await context.newPage();
    return {
      browser,
      context,
      page,
      persistent: true,
      async close(): Promise<void> {
        await browser.close().catch(() => undefined);
      }
    };
  }

  if (config.userDataDir) {
    const userDataDir = await prepareUserDataDir(config.userDataDir);
    const launchOptions = {
      headless: !config.headed,
      acceptDownloads: false
    };
    const context = await chromium
      .launchPersistentContext(userDataDir, { ...launchOptions, channel: 'chrome' })
      .catch(() => chromium.launchPersistentContext(userDataDir, launchOptions));
    const page = firstUsablePage(context) ?? await context.newPage();
    return {
      context,
      page,
      persistent: true,
      async close(): Promise<void> {
        await context.close().catch(() => undefined);
      }
    };
  }

  const browser = await chromium.launch({
    headless: !config.headed,
    channel: 'chrome'
  }).catch(() => chromium.launch({ headless: !config.headed }));
  const context = await browser.newContext({ acceptDownloads: false });
  const page = await context.newPage();
  return {
    browser,
    context,
    page,
    persistent: false,
    async close(): Promise<void> {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  };
}

export async function navigateSession(session: LiveBrowserSession, targetUrl: string, timeoutMs: number): Promise<void> {
  await session.page.goto(targetUrl, {
    waitUntil: 'domcontentloaded',
    timeout: Math.min(timeoutMs, 60_000)
  });
}

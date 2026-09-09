import { chromium, type Browser } from 'playwright';
import type { AppConfig, LiveBrowserSession } from '../types.js';
import type { ProviderPreset } from '../providers/catalog.js';
import { UiChatExecutor } from './ui-executor.js';
import { browserLaunchArgs, navigateSession } from './browser-session.js';
import type { SessionFactoryResult } from './session-manager.js';

export async function createIsolatedUiSession(
  base: LiveBrowserSession,
  provider: ProviderPreset,
  config: AppConfig
): Promise<SessionFactoryResult> {
  const headed = base.headed ?? config.headed;

  // Persistent profiles and CDP sessions already provide the expensive part:
  // one authenticated browser context. A named KITT conversation only needs an
  // independent tab; spawning another Chromium process per X-Kitt-Session-Id
  // wastes hundreds of MB and duplicates background services.
  if (base.persistent) {
    const page = await base.context.newPage();
    const session: LiveBrowserSession = {
      context: base.context,
      page,
      browser: base.browser,
      persistent: true,
      headed,
      async close(): Promise<void> {
        await page.close().catch(() => undefined);
      }
    };
    try {
      await navigateSession(session, provider.ui.newChatUrl || config.targetUrl, config.manualInterventionTimeoutMs);
      const executor = new UiChatExecutor(session, provider, config);
      await executor.initialize();
      return { executor, browserSession: session };
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  const storageState = await base.context.storageState({ indexedDB: true });
  let ownedBrowser: Browser | undefined;
  let browser = base.browser;

  if (!browser || !browser.isConnected()) {
    const launchOptions = { headless: !headed, args: browserLaunchArgs() };
    ownedBrowser = await chromium.launch({
      ...launchOptions,
      channel: 'chrome'
    }).catch(() => chromium.launch(launchOptions));
    browser = ownedBrowser;
  }

  const context = await browser.newContext({
    acceptDownloads: false,
    storageState
  });
  const page = await context.newPage();
  const session: LiveBrowserSession = {
    context,
    page,
    browser,
    persistent: false,
    headed,
    async close(): Promise<void> {
      await context.close().catch(() => undefined);
      await ownedBrowser?.close().catch(() => undefined);
    }
  };

  try {
    await navigateSession(session, provider.ui.newChatUrl || config.targetUrl, config.manualInterventionTimeoutMs);
    const executor = new UiChatExecutor(session, provider, config);
    await executor.initialize();
    return { executor, browserSession: session };
  } catch (error) {
    await session.close();
    throw error;
  }
}

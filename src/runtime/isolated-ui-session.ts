import { chromium, type Browser } from 'playwright';
import type { AppConfig, LiveBrowserSession } from '../types.js';
import type { ProviderPreset } from '../providers/catalog.js';
import { UiChatExecutor } from './ui-executor.js';
import { navigateSession } from './browser-session.js';
import type { SessionFactoryResult } from './session-manager.js';

export async function createIsolatedUiSession(
  base: LiveBrowserSession,
  provider: ProviderPreset,
  config: AppConfig
): Promise<SessionFactoryResult> {
  const storageState = await base.context.storageState({ indexedDB: true });
  let ownedBrowser: Browser | undefined;
  let browser = base.browser;

  if (!browser || !browser.isConnected()) {
    ownedBrowser = await chromium.launch({
      headless: !config.headed,
      channel: 'chrome'
    }).catch(() => chromium.launch({ headless: !config.headed }));
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

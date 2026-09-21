import { chromium, type Browser } from 'playwright';
import type { AppConfig, JsonObject, LiveBrowserSession } from '../types.js';
import type { ProviderPreset } from '../providers/catalog.js';
import { browserLaunchArgs, navigateSession } from './browser-session.js';

export class BrowserSessionBroker {
  private active = 0;
  private created = 0;

  constructor(
    private readonly base: LiveBrowserSession,
    private readonly config: AppConfig
  ) {}

  async acquire(provider: ProviderPreset): Promise<LiveBrowserSession> {
    const session = this.base.persistent
      ? await this.acquireSharedContextPage()
      : await this.acquireIsolatedContext();

    try {
      await navigateSession(
        session,
        provider.ui.newChatUrl || this.config.targetUrl,
        this.config.manualInterventionTimeoutMs
      );
      return session;
    } catch (error) {
      await session.close().catch(() => undefined);
      throw error;
    }
  }

  snapshot(): JsonObject {
    return {
      version: 1,
      topology: this.base.persistent ? 'shared-auth-context-isolated-tabs' : 'isolated-contexts',
      active_leases: this.active,
      created_leases: this.created,
      authenticated_context_reused: this.base.persistent
    };
  }

  private lease(session: Omit<LiveBrowserSession, 'close'>, release: () => Promise<void>): LiveBrowserSession {
    this.active += 1;
    this.created += 1;
    let closed = false;
    return {
      ...session,
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        await release();
      }
    };
  }

  private async acquireSharedContextPage(): Promise<LiveBrowserSession> {
    const page = await this.base.context.newPage();
    const broker = this;
    return this.lease({
      context: this.base.context,
      page,
      ...(this.base.browser ? { browser: this.base.browser } : {}),
      persistent: true,
      headed: this.base.headed ?? this.config.headed
    }, async () => {
      await page.close().catch(() => undefined);
      broker.active = Math.max(0, broker.active - 1);
    });
  }

  private async acquireIsolatedContext(): Promise<LiveBrowserSession> {
    const storageState = await this.base.context.storageState({ indexedDB: true });
    let ownedBrowser: Browser | undefined;
    let browser = this.base.browser;

    if (!browser || !browser.isConnected()) {
      const launchOptions = {
        headless: !(this.base.headed ?? this.config.headed),
        args: browserLaunchArgs()
      };
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
    const broker = this;
    return this.lease({
      context,
      page,
      browser,
      persistent: false,
      headed: this.base.headed ?? this.config.headed
    }, async () => {
      await context.close().catch(() => undefined);
      await ownedBrowser?.close().catch(() => undefined);
      broker.active = Math.max(0, broker.active - 1);
    });
  }
}

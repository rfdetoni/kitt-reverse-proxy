import type { AppConfig, LiveBrowserSession } from '../types.js';
import type { ProviderPreset } from '../providers/catalog.js';
import { BrowserSessionBroker } from './browser-broker.js';
import { UiChatExecutor } from './ui-executor.js';
import type { SessionFactoryResult } from './session-manager.js';

export async function createIsolatedUiSession(
  base: LiveBrowserSession,
  provider: ProviderPreset,
  config: AppConfig,
  broker: BrowserSessionBroker = new BrowserSessionBroker(base, config)
): Promise<SessionFactoryResult> {
  const session = await broker.acquire(provider);
  try {
    const executor = new UiChatExecutor(session, provider, config);
    await executor.initialize();
    return { executor, browserSession: session };
  } catch (error) {
    await session.close().catch(() => undefined);
    throw error;
  }
}

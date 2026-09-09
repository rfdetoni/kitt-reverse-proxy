import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../logger.js';
import type {
  AppConfig,
  ChatExecutor,
  LiveBrowserSession
} from '../types.js';
import type { ProviderPreset } from '../providers/catalog.js';
import {
  openBrowserSession,
  navigateSession
} from './browser-session.js';
import {
  ManualInterventionRequiredError,
  UiChatExecutor
} from './ui-executor.js';
import { firstVisibleLocator } from './ui-dom.js';

const HEADLESS_PROBE_MS = 4_000;
const HEADLESS_AFTER_AUTH_PROBE_MS = 6_000;
const PROFILE_RELEASE_MS = 150;

export interface ManagedUiRuntime {
  executor: ChatExecutor;
  session: LiveBrowserSession;
}

export interface UiBrowserLifecycleDeps {
  open(config: AppConfig): Promise<LiveBrowserSession>;
  navigate(
    session: LiveBrowserSession,
    targetUrl: string,
    timeoutMs: number
  ): Promise<void>;
  ready(
    session: LiveBrowserSession,
    provider: ProviderPreset,
    timeoutMs: number
  ): Promise<boolean>;
  initialize(
    session: LiveBrowserSession,
    provider: ProviderPreset,
    config: AppConfig
  ): Promise<ChatExecutor>;
  pause(ms: number): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultReady(
  session: LiveBrowserSession,
  provider: ProviderPreset,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const input = await firstVisibleLocator(
      session.page,
      provider.ui.inputSelectors
    );
    if (input) return true;
    await session.page.waitForTimeout(125).catch(() => undefined);
  }
  return false;
}

const DEFAULT_DEPS: UiBrowserLifecycleDeps = {
  open: openBrowserSession,
  navigate: navigateSession,
  ready: defaultReady,
  async initialize(session, provider, config) {
    const executor = new UiChatExecutor(session, provider, config);
    await executor.initialize();
    return executor;
  },
  pause: sleep
};

function genericProfileId(targetUrl: string): string {
  let origin = targetUrl;
  try {
    origin = new URL(targetUrl).origin;
  } catch {
    // Config validation will reject malformed URLs before runtime creation.
  }
  const digest = createHash('sha256')
    .update(origin, 'utf8')
    .digest('hex')
    .slice(0, 12);
  return `generic-${digest}`;
}

export function persistentUiConfig(
  config: AppConfig,
  provider: ProviderPreset
): AppConfig {
  if (config.cdpUrl || config.userDataDir) return config;
  const profileId = provider.id === 'generic'
    ? genericProfileId(config.targetUrl)
    : provider.id;
  return {
    ...config,
    userDataDir: join(
      homedir(),
      '.kitt-reverse-proxy',
      profileId
    )
  };
}

async function openNavigated(
  config: AppConfig,
  provider: ProviderPreset,
  deps: UiBrowserLifecycleDeps
): Promise<LiveBrowserSession> {
  const session = await deps.open(config);
  try {
    await deps.navigate(
      session,
      config.targetUrl,
      config.manualInterventionTimeoutMs
    ).catch((error: unknown) => {
      logger.warn(
        `Navegação não concluiu normalmente: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
    return session;
  } catch (error) {
    await session.close().catch(() => undefined);
    throw error;
  }
}

async function initializeExisting(
  session: LiveBrowserSession,
  config: AppConfig,
  provider: ProviderPreset,
  deps: UiBrowserLifecycleDeps
): Promise<ManagedUiRuntime> {
  try {
    const executor = await deps.initialize(
      session,
      provider,
      config
    );
    return { executor, session };
  } catch (error) {
    await session.close().catch(() => undefined);
    throw error;
  }
}

async function openInitialized(
  config: AppConfig,
  provider: ProviderPreset,
  deps: UiBrowserLifecycleDeps
): Promise<ManagedUiRuntime> {
  const session = await openNavigated(config, provider, deps);
  return initializeExisting(session, config, provider, deps);
}

async function headlessCandidate(
  config: AppConfig,
  provider: ProviderPreset,
  deps: UiBrowserLifecycleDeps,
  probeMs: number
): Promise<ManagedUiRuntime | undefined> {
  const session = await openNavigated(config, provider, deps);
  const ready = await deps.ready(session, provider, probeMs)
    .catch(() => false);
  if (!ready) {
    await session.close().catch(() => undefined);
    return undefined;
  }
  return initializeExisting(session, config, provider, deps);
}

export async function createManagedUiRuntime(
  rawConfig: AppConfig,
  provider: ProviderPreset,
  deps: UiBrowserLifecycleDeps = DEFAULT_DEPS
): Promise<ManagedUiRuntime> {
  const config = persistentUiConfig(rawConfig, provider);

  // CDP is user-owned. Never close/relaunch a browser attached by the user.
  if (config.cdpUrl) {
    return openInitialized(config, provider, deps);
  }

  if (config.browserMode === 'headed') {
    return openInitialized(
      { ...config, headed: true },
      provider,
      deps
    );
  }

  const headlessConfig: AppConfig = {
    ...config,
    headed: false
  };

  logger.info('Validando sessão UI em modo headless...');
  const firstHeadless = await headlessCandidate(
    headlessConfig,
    provider,
    deps,
    HEADLESS_PROBE_MS
  );
  if (firstHeadless) {
    logger.info(
      'Sessão autenticada disponível; Chromium permanecerá invisível.'
    );
    return firstHeadless;
  }

  if (config.browserMode === 'headless') {
    throw new ManualInterventionRequiredError(
      'A sessão headless exige login ou intervenção manual. ' +
      'Inicie sem --headless para autenticação automática temporária, ' +
      'ou use --headed para manter a janela visível.'
    );
  }

  logger.info(
    'Autenticação/intervenção necessária. ' +
    'Abrindo Chromium visível temporariamente...'
  );
  const headedConfig: AppConfig = {
    ...config,
    headed: true
  };
  const authRuntime = await openInitialized(
    headedConfig,
    provider,
    deps
  );

  logger.success(
    'Sessão autenticada. Fechando Chromium visível e migrando para headless...'
  );
  await authRuntime.session.close().catch(() => undefined);
  await deps.pause(PROFILE_RELEASE_MS);

  const finalHeadless = await headlessCandidate(
    headlessConfig,
    provider,
    deps,
    HEADLESS_AFTER_AUTH_PROBE_MS
  );
  if (finalHeadless) {
    logger.success(
      'Sessão retomada em headless. A janela visível não precisa permanecer aberta.'
    );
    return finalHeadless;
  }

  logger.warn(
    'O provider não permaneceu operacional em headless após autenticação. ' +
    'Reabrindo Chromium visível; enquanto esse fallback estiver ativo, ' +
    'a janela não pode ser fechada.'
  );
  return openInitialized(
    headedConfig,
    provider,
    deps
  );
}

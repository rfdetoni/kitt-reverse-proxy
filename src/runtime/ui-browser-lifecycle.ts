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
import { openSystemChromeSession } from './native-chrome-session.js';
import {
  ManualInterventionRequiredError,
  UiChatExecutor
} from './ui-executor.js';
import { firstVisibleLocator } from './ui-dom.js';
import { selectorCandidates } from './semantic-locator.js';

const HEADLESS_PROBE_MS = 4_000;
const HEADLESS_AFTER_AUTH_PROBE_MS = 6_000;
const PROFILE_RELEASE_MS = 150;

export interface ManagedUiRuntime {
  executor: ChatExecutor;
  session: LiveBrowserSession;
}

export type UiBrowserLaunchMode =
  | 'default'
  | 'system-chrome'
  | 'system-chrome-auth';

export interface UiBrowserLaunch {
  mode: UiBrowserLaunchMode;
  launchUrl?: string;
}

export interface UiBrowserLifecycleDeps {
  open(
    config: AppConfig,
    launch?: UiBrowserLaunch
  ): Promise<LiveBrowserSession>;
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
      selectorCandidates(provider.ui.inputSelectors, 'composer').map((item) => item.selector)
    );
    if (input) return true;
    await session.page.waitForTimeout(125).catch(() => undefined);
  }
  return false;
}

const DEFAULT_DEPS: UiBrowserLifecycleDeps = {
  async open(config, launch) {
    if (launch?.mode === 'system-chrome' || launch?.mode === 'system-chrome-auth') {
      return openSystemChromeSession(config, {
        waitForManualAuth: launch.mode === 'system-chrome-auth',
        ...(launch.launchUrl ? { launchUrl: launch.launchUrl } : {})
      });
    }
    return openBrowserSession(config);
  },
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

function headedLaunch(
  provider: ProviderPreset,
  waitForManualAuth: boolean
): UiBrowserLaunch {
  if (provider.ui.manualAuthBrowser !== 'system-chrome') {
    return { mode: 'default' };
  }
  return {
    mode: waitForManualAuth ? 'system-chrome-auth' : 'system-chrome',
    ...(waitForManualAuth && provider.ui.manualAuthUrl
      ? { launchUrl: provider.ui.manualAuthUrl }
      : {})
  };
}

async function openNavigated(
  config: AppConfig,
  provider: ProviderPreset,
  deps: UiBrowserLifecycleDeps,
  launch: UiBrowserLaunch = { mode: 'default' }
): Promise<LiveBrowserSession> {
  const session = await deps.open(config, launch);
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
  deps: UiBrowserLifecycleDeps,
  launch: UiBrowserLaunch = { mode: 'default' }
): Promise<ManagedUiRuntime> {
  const session = await openNavigated(config, provider, deps, launch);
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
    const launch = headedLaunch(provider, true);
    if (launch.mode === 'system-chrome-auth') {
      logger.info(
        'Login humano protegido: abrindo Google Chrome estável sem controle Playwright. ' +
        'O KITT conectará por CDP somente após o login retornar ao provider.'
      );
    }
    return openInitialized(
      { ...config, headed: true },
      provider,
      deps,
      launch
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

  await deps.pause(PROFILE_RELEASE_MS);
  const authLaunch = headedLaunch(provider, true);
  logger.info(
    authLaunch.mode === 'system-chrome-auth'
      ? 'Autenticação necessária. Abrindo Google Chrome estável para login humano; ' +
        'o KITT só conectará ao navegador depois que o login terminar.'
      : 'Autenticação/intervenção necessária. Abrindo Chromium visível temporariamente...'
  );
  const headedConfig: AppConfig = {
    ...config,
    headed: true
  };
  const authRuntime = await openInitialized(
    headedConfig,
    provider,
    deps,
    authLaunch
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
    deps,
    headedLaunch(provider, false)
  );
}

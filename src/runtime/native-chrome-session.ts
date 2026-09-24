import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { delimiter, join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type { AppConfig, LiveBrowserSession } from '../types.js';

const CDP_POLL_MS = 250;
const AUTH_TARGET_STABLE_MS = 1_250;

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  return String(env.PATH || '')
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function systemChromeCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const explicit = [env.KITT_CHROME_BIN, env.CHROME_PATH]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  if (platform === 'darwin') {
    return [
      ...explicit,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      join(String(env.HOME || ''), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ].filter(Boolean);
  }

  if (platform === 'win32') {
    const roots = [
      env.LOCALAPPDATA,
      env.PROGRAMFILES,
      env['PROGRAMFILES(X86)']
    ].map((value) => String(value || '').trim()).filter(Boolean);
    const installed = roots.map((root) => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    const fromPath = pathEntries(env).map((root) => join(root, 'chrome.exe'));
    return [...explicit, ...installed, ...fromPath];
  }

  const fromPath = pathEntries(env).flatMap((root) => [
    join(root, 'google-chrome'),
    join(root, 'google-chrome-stable')
  ]);
  return [
    ...explicit,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/google-chrome',
    ...fromPath
  ];
}

export async function resolveSystemChrome(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const seen = new Set<string>();
  for (const candidate of systemChromeCandidates(platform, env)) {
    const normalized = resolve(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    try {
      await access(normalized, constants.X_OK);
      return normalized;
    } catch {
      // Try next installed Chrome candidate.
    }
  }
  throw new Error(
    'Google Chrome estável não foi encontrado. Instale o Chrome ou configure KITT_CHROME_BIN.'
  );
}

async function prepareUserDataDir(directory: string): Promise<string> {
  const target = resolve(directory);
  await mkdir(target, { recursive: true, mode: 0o700 });
  await chmod(target, 0o700).catch(() => undefined);
  return target;
}

async function availableLoopbackPort(): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Não foi possível reservar porta local para CDP.'));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

export function nativeChromeLaunchArgs(
  userDataDir: string,
  cdpPort: number,
  launchUrl: string
): string[] {
  return [
    `--remote-debugging-address=127.0.0.1`,
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    launchUrl
  ];
}

function targetHost(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

interface CdpTarget {
  type?: unknown;
  url?: unknown;
}

async function cdpTargets(baseUrl: string): Promise<CdpTarget[]> {
  try {
    const response = await fetch(`${baseUrl}/json/list`, {
      signal: AbortSignal.timeout(750)
    });
    if (!response.ok) return [];
    const value = await response.json();
    return Array.isArray(value) ? value as CdpTarget[] : [];
  } catch {
    return [];
  }
}

async function waitForCdp(
  child: ChildProcess,
  cdpUrl: string,
  config: AppConfig,
  waitForAuthReturn: boolean
): Promise<void> {
  const deadline = Date.now() + Math.max(5_000, config.manualInterventionTimeoutMs);
  const expectedHost = targetHost(config.targetUrl);
  let stableSince = 0;
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.once('exit', (code, signal) => {
    exited = { code, signal };
  });

  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        `Chrome foi encerrado antes da sessão ficar pronta (code=${String(exited.code)}, signal=${String(exited.signal)}).`
      );
    }

    const targets = await cdpTargets(cdpUrl);
    if (!waitForAuthReturn && targets.length > 0) return;

    const atTarget = targets.some((item) => {
      if (item.type !== 'page' || typeof item.url !== 'string') return false;
      try {
        return new URL(item.url).hostname.toLowerCase() === expectedHost;
      } catch {
        return false;
      }
    });
    if (atTarget) {
      stableSince ||= Date.now();
      if (Date.now() - stableSince >= AUTH_TARGET_STABLE_MS) return;
    } else {
      stableSince = 0;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, CDP_POLL_MS));
  }

  throw new Error(
    waitForAuthReturn
      ? 'Tempo esgotado aguardando o login manual voltar ao Gemini.'
      : 'Tempo esgotado aguardando o Chrome disponibilizar a interface CDP.'
  );
}

function firstUsablePage(context: BrowserContext, preferredHost: string): Page | undefined {
  return context.pages().find((page) => {
    if (page.isClosed()) return false;
    try {
      return new URL(page.url()).hostname.toLowerCase() === preferredHost;
    } catch {
      return false;
    }
  }) ?? context.pages().find((page) => !page.isClosed());
}

export async function openSystemChromeSession(
  config: AppConfig,
  options: {
    waitForManualAuth?: boolean;
    launchUrl?: string;
  } = {}
): Promise<LiveBrowserSession> {
  if (!config.userDataDir) {
    throw new Error('Chrome nativo exige um userDataDir persistente dedicado.');
  }

  const executable = await resolveSystemChrome();
  const userDataDir = await prepareUserDataDir(config.userDataDir);
  const cdpPort = await availableLoopbackPort();
  const cdpUrl = `http://127.0.0.1:${cdpPort}`;
  const launchUrl = options.launchUrl || config.targetUrl;
  const child = spawn(
    executable,
    nativeChromeLaunchArgs(userDataDir, cdpPort, launchUrl),
    {
      stdio: 'ignore',
      windowsHide: false
    }
  );

  try {
    await waitForCdp(child, cdpUrl, config, options.waitForManualAuth === true);
    const browser = await chromium.connectOverCDP(cdpUrl);
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close().catch(() => undefined);
      throw new Error('Chrome nativo não expôs um contexto de navegador utilizável.');
    }
    const preferredHost = targetHost(config.targetUrl);
    const page = firstUsablePage(context, preferredHost) ?? await context.newPage();

    return {
      browser,
      context,
      page,
      persistent: true,
      headed: true,
      async close(): Promise<void> {
        await browser.close().catch(() => undefined);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
        }
      }
    };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
    throw error;
  }
}

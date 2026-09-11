import { readFile } from 'node:fs/promises';
import { dirname, resolve, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCK_URL = 'https://raw.githubusercontent.com/rfdetoni/kitt/main/ecosystem.lock.json';
export const INSTALL_SH_URL = 'https://raw.githubusercontent.com/rfdetoni/kitt/main/install.sh';
export const INSTALL_PS1_URL = 'https://raw.githubusercontent.com/rfdetoni/kitt/main/install.ps1';

const SHA_RE = /^[0-9a-f]{40}$/;
const MODULE_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface InstalledState {
  requested_modules?: unknown;
  repositories?: unknown;
  launchers?: unknown;
  with_ai_workers?: unknown;
  portable?: unknown;
  ref?: unknown;
  source_ref?: unknown;
}

export interface EcosystemLock {
  components?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stateCandidates(moduleUrl: string): string[] {
  const candidates: string[] = [];
  const configured = process.env.KITT_HOME?.trim();
  if (configured) candidates.push(resolve(configured, 'installed-state.json'));

  const modulePath = fileURLToPath(moduleUrl);
  const repoRoot = resolve(dirname(modulePath), '..');
  candidates.push(resolve(repoRoot, '..', 'installed-state.json'));
  return [...new Set(candidates)];
}

async function findState(moduleUrl: string): Promise<{ path: string; state: InstalledState } | null> {
  for (const path of stateCandidates(moduleUrl)) {
    const state = await readJson(path);
    if (state) return { path, state };
  }
  return null;
}

async function fetchLock(timeoutMs: number): Promise<EcosystemLock | null> {
  try {
    const response = await fetch(LOCK_URL, {
      headers: {
        accept: 'application/json',
        'user-agent': 'kitt-reverse-proxy-update-check'
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > 64 * 1024) return null;
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function findOutdatedComponents(
  state: InstalledState,
  lock: EcosystemLock
): string[] {
  if (!isRecord(state.repositories) || !isRecord(lock.components)) return [];

  const outdated: string[] = [];
  for (const [repository, installedSha] of Object.entries(state.repositories)) {
    const currentSha = lock.components[repository];
    if (typeof installedSha !== 'string' || !SHA_RE.test(installedSha)) continue;
    if (typeof currentSha !== 'string' || !SHA_RE.test(currentSha)) continue;
    if (installedSha !== currentSha) outdated.push(repository);
  }
  return outdated.sort();
}

function requestedModules(state: InstalledState, fallbackModule: string): string[] {
  if (Array.isArray(state.requested_modules)) {
    const modules = state.requested_modules.filter(
      (value): value is string => typeof value === 'string' && MODULE_RE.test(value)
    );
    if (modules.length) return [...new Set(modules)];
  }
  return [fallbackModule];
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function pathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix;
}

function inferBinDir(state: InstalledState, platform: NodeJS.Platform): string | null {
  if (!Array.isArray(state.launchers)) return null;
  const paths = pathApi(platform);
  for (const value of state.launchers) {
    if (typeof value === 'string' && value.trim()) return paths.dirname(value);
  }
  return null;
}

export function buildUpdateCommand(
  statePath: string,
  state: InstalledState,
  fallbackModule: string,
  platform: NodeJS.Platform = process.platform
): string {
  const paths = pathApi(platform);
  const modules = requestedModules(state, fallbackModule).join(',');
  const root = paths.dirname(statePath);
  const binDir = inferBinDir(state, platform);
  const args = ['--yes', '--modules', modules, '--root', root];
  if (binDir) args.push('--bin-dir', binDir);
  if (Boolean(state.with_ai_workers)) args.push('--with-ai-workers');
  if (Boolean(state.portable)) args.push('--portable');

  if (platform === 'win32') {
    const rendered = args
      .map((value) => (value.startsWith('--') ? value : quotePowerShell(value)))
      .join(' ');
    return `& ([ScriptBlock]::Create((Invoke-RestMethod ${quotePowerShell(INSTALL_PS1_URL)}))) ${rendered}`;
  }

  return `curl -fsSL ${quotePosix(INSTALL_SH_URL)} | sh -s -- ${args.map(quotePosix).join(' ')}`;
}

export async function notifyIfUpdateAvailable(
  moduleUrl: string,
  timeoutMs = 800
): Promise<boolean> {
  if (/^(1|true|yes|on)$/i.test(process.env.KITT_DISABLE_UPDATE_CHECK?.trim() ?? '')) {
    return false;
  }

  try {
    const managed = await findState(moduleUrl);
    if (!managed) return false;
    if (managed.state.ref || managed.state.source_ref) return false;

    const lock = await fetchLock(timeoutMs);
    if (!lock) return false;
    const outdated = findOutdatedComponents(managed.state, lock);
    if (!outdated.length) return false;

    const command = buildUpdateCommand(
      managed.path,
      managed.state,
      'reverse-proxy'
    );
    const names = outdated.map((repository) => repository.split('/').at(-1)).join(', ');
    console.error(`\n[K.I.T.T.] Update available for the tested ecosystem (${names}).`);
    console.error('Update manually with:');
    console.error(`  ${command}\n`);
    return true;
  } catch {
    // Advisory only: update discovery must never prevent the proxy from starting.
    return false;
  }
}

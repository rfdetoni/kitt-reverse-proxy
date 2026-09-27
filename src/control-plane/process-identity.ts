import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function linuxFingerprint(pid: number): string | undefined {
  try {
    const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
    const boundary = stat.lastIndexOf(') ');
    if (boundary < 0) return undefined;
    const fields = stat.slice(boundary + 2).trim().split(/\s+/);
    const startTicks = fields[19];
    const cmdline = readFileSync('/proc/' + pid + '/cmdline', 'utf8').replace(/\0/g, ' ').trim();
    if (!startTicks) return undefined;
    return digest(['linux', startTicks, cmdline]);
  } catch {
    return undefined;
  }
}

function windowsFingerprint(pid: number): string | undefined {
  const script =
    '$p=Get-CimInstance Win32_Process -Filter "ProcessId = ' + pid + '"; ' +
    'if($p){$p | Select-Object CreationDate,CommandLine,ExecutablePath | ConvertTo-Json -Compress}';
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 2_000, maxBuffer: 256 * 1024 }
  );
  if (result.status !== 0 || !result.stdout.trim()) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as {
      CreationDate?: unknown;
      CommandLine?: unknown;
      ExecutablePath?: unknown;
    };
    const created = String(parsed.CreationDate ?? '').trim();
    if (!created) return undefined;
    return digest([
      'win32',
      created,
      String(parsed.ExecutablePath ?? ''),
      String(parsed.CommandLine ?? '')
    ]);
  } catch {
    return undefined;
  }
}

function posixFingerprint(pid: number): string | undefined {
  const result = spawnSync(
    'ps',
    ['-p', String(pid), '-o', 'lstart=', '-o', 'command='],
    { encoding: 'utf8', timeout: 2_000, maxBuffer: 256 * 1024 }
  );
  if (result.status !== 0) return undefined;
  const value = result.stdout.trim();
  return value ? digest([process.platform, value]) : undefined;
}

export function processFingerprint(pid: number): string | undefined {
  if (!processAlive(pid)) return undefined;
  if (process.platform === 'linux') return linuxFingerprint(pid);
  if (process.platform === 'win32') return windowsFingerprint(pid);
  return posixFingerprint(pid);
}

export function processMatches(pid: number, expected: string | undefined): boolean {
  if (!expected) return false;
  const current = processFingerprint(pid);
  return Boolean(current && current === expected);
}

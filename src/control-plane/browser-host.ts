import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { nativeChromeLaunchArgs, resolveSystemChrome } from '../runtime/native-chrome-session.js';

function flagValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requiredFlag(args: readonly string[], name: string): string {
  const value = flagValue(args, name);
  if (!value) throw new Error(`Missing required flag: ${name}`);
  return value;
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolveDone) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      resolveDone();
    }, 2_000);
    timer.unref();
    child.once('exit', () => {
      clearTimeout(timer);
      resolveDone();
    });
  });
}

export async function runBrowserHostCli(args: string[]): Promise<number> {
  const action = args[0] || '';
  if (action !== 'serve') {
    throw new Error(
      'Usage: kitt-reverse-proxy browser-host serve --profile <dir> --target <url> --cdp-port <port>'
    );
  }

  const profileDirectory = resolve(requiredFlag(args, '--profile'));
  const targetUrl = new URL(requiredFlag(args, '--target'));
  if (
    !['http:', 'https:'].includes(targetUrl.protocol)
    || targetUrl.username
    || targetUrl.password
  ) {
    throw new Error('--target must be an http(s) URL without embedded credentials.');
  }
  const target = targetUrl.toString();
  const cdpPort = Number(requiredFlag(args, '--cdp-port'));
  if (!Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65_535) {
    throw new Error('--cdp-port must be an integer between 1 and 65535.');
  }

  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  await chmod(profileDirectory, 0o700).catch(() => undefined);
  const executable = await resolveSystemChrome();
  const chrome = spawn(
    executable,
    nativeChromeLaunchArgs(profileDirectory, cdpPort, target),
    { stdio: 'ignore', windowsHide: false }
  );

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await terminate(chrome);
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  return await new Promise<number>((resolveCode, reject) => {
    chrome.once('error', reject);
    chrome.once('exit', (code, signal) => {
      if (!stopping && code !== 0) {
        reject(new Error(
          `Browser host Chrome exited unexpectedly (code=${String(code)}, signal=${String(signal)}).`
        ));
        return;
      }
      resolveCode(0);
    });
  });
}

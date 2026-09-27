import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { processAlive, processFingerprint, processMatches } from './process-identity.js';

interface LockOwner {
  pid: number;
  fingerprint?: string;
  token: string;
  createdAt: number;
}

const LOCK_RETRY_MS = 25;
const OWNER_WRITE_GRACE_MS = 2_000;

function sleepSync(ms: number): void {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

function ownerFile(directory: string): string {
  return join(directory, 'owner.json');
}

function readOwner(directory: string): LockOwner | undefined {
  try {
    const parsed = JSON.parse(readFileSync(ownerFile(directory), 'utf8')) as Partial<LockOwner>;
    if (!Number.isInteger(parsed.pid) || typeof parsed.token !== 'string' || !parsed.token) {
      return undefined;
    }
    return {
      pid: Number(parsed.pid),
      token: parsed.token,
      createdAt: Number(parsed.createdAt || 0),
      ...(typeof parsed.fingerprint === 'string' && parsed.fingerprint
        ? { fingerprint: parsed.fingerprint }
        : {})
    };
  } catch {
    return undefined;
  }
}

function staleLock(directory: string): boolean {
  const owner = readOwner(directory);
  if (owner) {
    return owner.fingerprint
      ? !processMatches(owner.pid, owner.fingerprint)
      : !processAlive(owner.pid);
  }
  try {
    return Date.now() - statSync(directory).mtimeMs > OWNER_WRITE_GRACE_MS;
  } catch {
    return true;
  }
}

function createOwner(directory: string): LockOwner {
  const fingerprint = processFingerprint(process.pid);
  const owner: LockOwner = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: Date.now(),
    ...(fingerprint ? { fingerprint } : {})
  };
  writeFileSync(ownerFile(directory), JSON.stringify(owner), { mode: 0o600 });
  return owner;
}

function release(directory: string, token: string): void {
  const owner = readOwner(directory);
  if (!owner || owner.token !== token) return;
  rmSync(directory, { recursive: true, force: true });
}

function tryAcquire(directory: string): LockOwner | undefined {
  try {
    mkdirSync(directory);
    return createOwner(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (staleLock(directory)) rmSync(directory, { recursive: true, force: true });
    return undefined;
  }
}

export async function withFileLock<T>(
  root: string,
  name: string,
  operation: () => Promise<T> | T,
  timeoutMs = 15_000
): Promise<T> {
  const control = join(root, 'control');
  mkdirSync(control, { recursive: true });
  const directory = join(control, '.' + name + '.lock');
  const deadline = Date.now() + timeoutMs;
  let owner: LockOwner | undefined;
  while (!(owner = tryAcquire(directory))) {
    if (Date.now() >= deadline) throw new Error('Timed out acquiring control lock: ' + name);
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
  try {
    return await operation();
  } finally {
    release(directory, owner.token);
  }
}

export function withFileLockSync<T>(
  root: string,
  name: string,
  operation: () => T,
  timeoutMs = 5_000
): T {
  const control = join(root, 'control');
  mkdirSync(control, { recursive: true });
  const directory = join(control, '.' + name + '.lock');
  const deadline = Date.now() + timeoutMs;
  let owner: LockOwner | undefined;
  while (!(owner = tryAcquire(directory))) {
    if (Date.now() >= deadline) throw new Error('Timed out acquiring control lock: ' + name);
    sleepSync(LOCK_RETRY_MS);
  }
  try {
    return operation();
  } finally {
    release(directory, owner.token);
  }
}

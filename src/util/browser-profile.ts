import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../types.js';

const SAFE_PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function profileKey(providerId: string, targetUrl: string): string {
  const normalized = providerId.trim().toLowerCase();
  if (!SAFE_PROVIDER_ID.test(normalized)) {
    throw new Error(`Provider inválido para perfil Chromium: ${providerId}`);
  }
  if (normalized !== 'generic') return normalized;

  let origin = targetUrl;
  try {
    origin = new URL(targetUrl).origin;
  } catch {
    // Target URL is validated by configuration before runtime creation.
  }
  const digest = createHash('sha256').update(origin).digest('hex').slice(0, 12);
  return `generic-${digest}`;
}

export function browserProfileDirectory(providerId: string, targetUrl: string): string {
  return join(homedir(), '.kitt-reverse-proxy', profileKey(providerId, targetUrl));
}

export function withPersistentBrowserProfile(config: AppConfig, providerId: string): AppConfig {
  if (config.cdpUrl || config.userDataDir) return config;
  return Object.freeze({
    ...config,
    userDataDir: browserProfileDirectory(providerId, config.targetUrl)
  });
}

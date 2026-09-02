import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_BYTES = 2 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

function root(): string {
  if (process.env.KITT_CONTROL_CENTER_CONFIG) return process.env.KITT_CONTROL_CENTER_CONFIG;
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'kitt', 'control-center', 'overrides.json');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'kitt', 'control-center', 'overrides.json');
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'kitt', 'control-center', 'overrides.json');
}

export function controlCenterSection(sectionId: string): JsonObject {
  const path = root();
  try {
    if (statSync(path).size > MAX_BYTES) throw new Error('KITT Control Center overlay exceeds 2 MiB');
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as JsonObject;
    if (parsed.schema_version !== 1) throw new Error('Unsupported KITT Control Center schema');
    const components = parsed.components;
    if (!components || typeof components !== 'object' || Array.isArray(components)) return {};
    const section = (components as JsonObject)[sectionId];
    return section && typeof section === 'object' && !Array.isArray(section) ? { ...(section as JsonObject) } : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export function stringSetting(section: JsonObject, key: string): string | undefined {
  const value = section[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function numberSetting(section: JsonObject, key: string): number | undefined {
  const value = section[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function boolSetting(section: JsonObject, key: string): boolean | undefined {
  const value = section[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function stringListSetting(section: JsonObject, key: string): string[] | undefined {
  const value = section[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return undefined;
  return value.map((item) => item.trim()).filter(Boolean);
}

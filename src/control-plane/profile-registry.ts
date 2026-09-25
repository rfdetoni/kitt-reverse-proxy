import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SCHEMA_VERSION = 1;

export interface BrowserProfileRecord {
  id: string;
  name: string;
  directory: string;
  providers: string[];
  createdAt: string;
  updatedAt: string;
  legacy: boolean;
}

interface ProfileFile {
  schemaVersion: number;
  profiles: BrowserProfileRecord[];
}

export function normalizeProfileId(value: string): string {
  const id = value.trim().toLowerCase().replace(/\s+/g, '-');
  if (!PROFILE_ID.test(id)) {
    throw new Error('Profile id must use lowercase letters, numbers, dot, underscore or dash (max 64 chars).');
  }
  return id;
}

export class ProfileRegistry {
  readonly root: string;
  private readonly controlDir: string;
  private readonly file: string;

  constructor(root = join(homedir(), '.kitt-reverse-proxy')) {
    this.root = root;
    this.controlDir = join(root, 'control');
    this.file = join(this.controlDir, 'profiles.json');
    mkdirSync(this.controlDir, { recursive: true });
  }

  list(): BrowserProfileRecord[] {
    return this.read().profiles;
  }

  get(id: string): BrowserProfileRecord | undefined {
    const normalized = normalizeProfileId(id);
    return this.list().find((profile) => profile.id === normalized);
  }

  create(name: string, providers: readonly string[] = []): BrowserProfileRecord {
    const id = normalizeProfileId(name);
    const state = this.read();
    const existing = state.profiles.find((profile) => profile.id === id);
    if (existing) return existing;

    const now = new Date().toISOString();
    const directory = join(this.root, 'profiles', id);
    mkdirSync(directory, { recursive: true });
    const record: BrowserProfileRecord = {
      id,
      name: name.trim() || id,
      directory,
      providers: [...new Set(providers.map((provider) => provider.trim().toLowerCase()).filter(Boolean))],
      createdAt: now,
      updatedAt: now,
      legacy: false
    };
    state.profiles.push(record);
    this.write(state);
    return record;
  }

  importLegacy(providerIds: readonly string[]): BrowserProfileRecord[] {
    const state = this.read();
    let changed = false;
    for (const provider of providerIds) {
      const id = provider.trim().toLowerCase();
      if (!id || id === 'generic') continue;
      const directory = join(this.root, id);
      if (!existsSync(directory)) continue;
      if (state.profiles.some((profile) => profile.directory === directory)) continue;
      const now = new Date().toISOString();
      state.profiles.push({
        id: normalizeProfileId(`${id}-default`),
        name: `${id} default`,
        directory,
        providers: [id],
        createdAt: now,
        updatedAt: now,
        legacy: true
      });
      changed = true;
    }
    if (changed) this.write(state);
    return state.profiles;
  }

  resolve(provider: string, requested?: string): BrowserProfileRecord {
    const providerId = provider.trim().toLowerCase();
    const profiles = this.importLegacy([providerId]);
    if (requested) {
      const existing = this.get(requested);
      return existing ? this.markProvider(existing.id, providerId) : this.create(requested, [providerId]);
    }
    const compatible = profiles.find((profile) => profile.providers.includes(providerId));
    return compatible ?? this.create(`${providerId}-default`, [providerId]);
  }

  markProvider(id: string, provider: string): BrowserProfileRecord {
    const normalized = normalizeProfileId(id);
    const providerId = provider.trim().toLowerCase();
    const state = this.read();
    const index = state.profiles.findIndex((profile) => profile.id === normalized);
    if (index < 0) throw new Error(`Unknown browser profile: ${normalized}`);
    const current = state.profiles[index]!;
    const updated = {
      ...current,
      providers: [...new Set([...current.providers, providerId].filter(Boolean))],
      updatedAt: new Date().toISOString()
    };
    state.profiles[index] = updated;
    this.write(state);
    return updated;
  }

  remove(id: string, deleteData = false): boolean {
    const normalized = normalizeProfileId(id);
    const state = this.read();
    const record = state.profiles.find((profile) => profile.id === normalized);
    if (!record) return false;
    state.profiles = state.profiles.filter((profile) => profile.id !== normalized);
    this.write(state);
    if (deleteData && !record.legacy) rmSync(record.directory, { recursive: true, force: true });
    return true;
  }

  private read(): ProfileFile {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<ProfileFile>;
      if (parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.profiles)) return this.empty();
      return {
        schemaVersion: SCHEMA_VERSION,
        profiles: parsed.profiles.filter((profile): profile is BrowserProfileRecord =>
          Boolean(profile && typeof profile.id === 'string' && typeof profile.directory === 'string')
        )
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.empty();
      throw error;
    }
  }

  private empty(): ProfileFile {
    return { schemaVersion: SCHEMA_VERSION, profiles: [] };
  }

  private write(state: ProfileFile): void {
    mkdirSync(this.controlDir, { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}

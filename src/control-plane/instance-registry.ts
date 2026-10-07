import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { withFileLockSync } from './file-lock.js';
import { processMatches } from './process-identity.js';

const INSTANCE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SCHEMA_VERSION = 2;

export interface ProxyInstanceRecord {
  id: string;
  provider: string;
  model: string;
  target: string;
  profileId: string;
  profileDirectory: string;
  host: string;
  port: number;
  pid: number;
  processFingerprint: string;
  startedAt: string;
  logLevel?: 0 | 1 | 2;
  logContent?: 'none' | 'metadata' | 'full';
  logFile?: string;
  ownerPid?: number;
  ownerFingerprint?: string;
  browserHostPid?: number;
  browserHostFingerprint?: string;
  browserHostCdpPort?: number;
  browserHostMode?: 'shared-profile';
}

interface InstanceFile {
  schemaVersion: number;
  instances: ProxyInstanceRecord[];
}

export function normalizeInstanceId(value: string): string {
  const id = value.trim().toLowerCase().replace(/\s+/g, '-');
  if (!INSTANCE_ID.test(id)) {
    throw new Error('Instance id must use lowercase letters, numbers, dot, underscore or dash (max 64 chars).');
  }
  return id;
}

export class InstanceRegistry {
  private readonly root: string;
  private readonly controlDir: string;
  private readonly file: string;
  private cached: InstanceFile | undefined;
  private cachedMtimeMs = -1;

  constructor(root = join(homedir(), '.kitt-reverse-proxy')) {
    this.root = root;
    this.controlDir = join(root, 'control');
    this.file = join(this.controlDir, 'instances.json');
    mkdirSync(this.controlDir, { recursive: true });
  }

  list(): ProxyInstanceRecord[] {
    return this.read().instances;
  }

  listActive(): ProxyInstanceRecord[] {
    return withFileLockSync(this.root, 'instances', () => {
      const state = this.read();
      const active = state.instances.filter((instance) =>
        processMatches(instance.pid, instance.processFingerprint)
      );
      if (active.length !== state.instances.length) {
        state.instances = active;
        this.write(state);
      }
      return active;
    });
  }

  get(id: string): ProxyInstanceRecord | undefined {
    const normalized = normalizeInstanceId(id);
    return this.list().find((instance) => instance.id === normalized);
  }

  put(record: ProxyInstanceRecord): ProxyInstanceRecord {
    return withFileLockSync(this.root, 'instances', () => {
      const state = this.read();
      const normalized = normalizeInstanceId(record.id);
      const next = { ...record, id: normalized };
      state.instances = state.instances.filter((instance) => instance.id !== normalized);
      state.instances.push(next);
      this.write(state);
      return next;
    });
  }

  remove(id: string): boolean {
    return withFileLockSync(this.root, 'instances', () => {
      const normalized = normalizeInstanceId(id);
      const state = this.read();
      const before = state.instances.length;
      state.instances = state.instances.filter((instance) => instance.id !== normalized);
      if (state.instances.length !== before) this.write(state);
      return state.instances.length !== before;
    });
  }

  private read(): InstanceFile {
    try {
      const mtimeMs = statSync(this.file).mtimeMs;
      if (this.cached && this.cachedMtimeMs === mtimeMs) {
        return {
          schemaVersion: SCHEMA_VERSION,
          instances: [...this.cached.instances]
        };
      }
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<InstanceFile>;
      const state = parsed.schemaVersion === SCHEMA_VERSION && Array.isArray(parsed.instances)
        ? {
            schemaVersion: SCHEMA_VERSION,
            instances: parsed.instances.filter((instance): instance is ProxyInstanceRecord =>
              Boolean(
                instance
                && typeof instance.id === 'string'
                && Number.isInteger(instance.pid)
                && typeof instance.processFingerprint === 'string'
                && instance.processFingerprint
              )
            )
          }
        : this.empty();
      this.cached = state;
      this.cachedMtimeMs = mtimeMs;
      return {
        schemaVersion: SCHEMA_VERSION,
        instances: [...state.instances]
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const empty = this.empty();
        this.cached = empty;
        this.cachedMtimeMs = -1;
        return empty;
      }
      throw error;
    }
  }

  private empty(): InstanceFile {
    return { schemaVersion: SCHEMA_VERSION, instances: [] };
  }

  private write(state: InstanceFile): void {
    const temporary = this.file + '.' + process.pid + '.' + Date.now() + '.tmp';
    writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(temporary, this.file);
    this.cached = {
      schemaVersion: SCHEMA_VERSION,
      instances: [...state.instances]
    };
    this.cachedMtimeMs = statSync(this.file).mtimeMs;
  }
}

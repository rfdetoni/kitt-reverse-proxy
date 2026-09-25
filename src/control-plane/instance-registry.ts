import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const INSTANCE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SCHEMA_VERSION = 1;

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
  startedAt: string;
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

export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class InstanceRegistry {
  private readonly controlDir: string;
  private readonly file: string;

  constructor(root = join(homedir(), '.kitt-reverse-proxy')) {
    this.controlDir = join(root, 'control');
    this.file = join(this.controlDir, 'instances.json');
    mkdirSync(this.controlDir, { recursive: true });
  }

  list(): ProxyInstanceRecord[] {
    return this.read().instances;
  }

  listActive(): ProxyInstanceRecord[] {
    const state = this.read();
    const active = state.instances.filter((instance) => processAlive(instance.pid));
    if (active.length !== state.instances.length) {
      state.instances = active;
      this.write(state);
    }
    return active;
  }

  get(id: string): ProxyInstanceRecord | undefined {
    const normalized = normalizeInstanceId(id);
    return this.list().find((instance) => instance.id === normalized);
  }

  put(record: ProxyInstanceRecord): ProxyInstanceRecord {
    const state = this.read();
    const normalized = normalizeInstanceId(record.id);
    const next = { ...record, id: normalized };
    state.instances = state.instances.filter((instance) => instance.id !== normalized);
    state.instances.push(next);
    this.write(state);
    return next;
  }

  remove(id: string): boolean {
    const normalized = normalizeInstanceId(id);
    const state = this.read();
    const before = state.instances.length;
    state.instances = state.instances.filter((instance) => instance.id !== normalized);
    if (state.instances.length !== before) this.write(state);
    return state.instances.length !== before;
  }

  private read(): InstanceFile {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<InstanceFile>;
      if (parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.instances)) return this.empty();
      return {
        schemaVersion: SCHEMA_VERSION,
        instances: parsed.instances.filter((instance): instance is ProxyInstanceRecord =>
          Boolean(instance && typeof instance.id === 'string' && Number.isInteger(instance.pid))
        )
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.empty();
      throw error;
    }
  }

  private empty(): InstanceFile {
    return { schemaVersion: SCHEMA_VERSION, instances: [] };
  }

  private write(state: InstanceFile): void {
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}

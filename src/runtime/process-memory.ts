import { readFileSync, readdirSync } from 'node:fs';

/** Bounded Linux PSS sampling avoids double-counting shared Chromium pages. */
export class ProcessMemorySampler {
  private cached = { bytes: process.memoryUsage().rss, mode: 'node_rss_fallback', partial: true, processes: 1 };
  private sampledAt = 0;
  snapshot(): typeof this.cached {
    if (Date.now() - this.sampledAt < 5_000) return this.cached;
    this.sampledAt = Date.now();
    if (process.platform !== 'linux') { this.cached.bytes = process.memoryUsage().rss; return this.cached; }
    const started = Date.now();
    const sharedPid = Number(process.env.KITT_SHARED_BROWSER_PID);
    const queue = [process.pid, ...(Number.isSafeInteger(sharedPid) && sharedPid > 0 ? [sharedPid] : [])];
    const visited = new Set<number>();
    let bytes = 0; let partial = false;
    while (queue.length && visited.size < 512 && Date.now() - started < 50) {
      const pid = queue.shift()!;
      if (visited.has(pid)) continue;
      visited.add(pid);
      try {
        const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
        const pss = /^Pss:\s+(\d+) kB$/m.exec(rollup);
        if (!pss) throw new Error('PSS unavailable');
        bytes += Number(pss[1]) * 1024;
      } catch {
        partial = true;
        try { bytes += Number(/^VmRSS:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0) * 1024; }
        catch { if (pid === process.pid) bytes += process.memoryUsage().rss; }
      }
      try {
        const tasks = readdirSync(`/proc/${pid}/task`);
        if (tasks.length > 32) partial = true;
        for (const tid of tasks.slice(0, 32)) {
          if (Date.now() - started >= 50) { partial = true; break; }
          const children = readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8').trim().split(/\s+/)
            .map(Number).filter((child) => Number.isSafeInteger(child) && child > 0);
          if (children.length > 2048 - queue.length) partial = true;
          queue.push(...children.slice(0, Math.max(0, 2048 - queue.length)));
        }
      } catch { partial = true; }
    }
    this.cached = { bytes, mode: 'linux_process_tree_pss', partial: partial || queue.length > 0, processes: visited.size };
    return this.cached;
  }
}

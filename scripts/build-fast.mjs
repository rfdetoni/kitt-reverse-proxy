#!/usr/bin/env node
import { readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

const root = process.cwd();
const srcDir = resolve(root, 'src');
const outDir = resolve(root, 'dist');

async function collectTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  }));
  return nested.flat();
}

let esbuild;
try {
  ({ build: esbuild } = await import('esbuild'));
} catch (error) {
  console.error(`Fast build requires the esbuild package: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(78);
}

const entryPoints = await collectTypeScriptFiles(srcDir);
if (entryPoints.length === 0) {
  console.error('No TypeScript source files found under src/.');
  process.exit(2);
}

await rm(outDir, { recursive: true, force: true });
const startedAt = performance.now();

await esbuild({
  absWorkingDir: root,
  entryPoints,
  outbase: srcDir,
  outdir: outDir,
  bundle: false,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  charset: 'utf8',
  legalComments: 'none',
  logLevel: 'warning',
  tsconfig: resolve(root, 'tsconfig.build.json')
});

const elapsed = Math.round(performance.now() - startedAt);
console.log(`Fast esbuild compile: ${entryPoints.length} modules in ${elapsed}ms.`);

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUpdateCommand,
  findOutdatedComponents,
  type EcosystemLock,
  type InstalledState,
} from '../src/update-check.js';

test('update check detects only installed components that differ from the lock', () => {
  const state: InstalledState = {
    repositories: {
      'rfdetoni/kitt-agent-cli': '1'.repeat(40),
      'rfdetoni/kitt-reverse-proxy': '2'.repeat(40),
    },
  };
  const lock: EcosystemLock = {
    components: {
      'rfdetoni/kitt-agent-cli': '3'.repeat(40),
      'rfdetoni/kitt-reverse-proxy': '2'.repeat(40),
      'rfdetoni/kitt-memory': '4'.repeat(40),
    },
  };

  assert.deepEqual(findOutdatedComponents(state, lock), ['rfdetoni/kitt-agent-cli']);
});

test('POSIX update command preserves the managed installation shape', () => {
  const state: InstalledState = {
    requested_modules: ['reverse-proxy'],
    launchers: ['/home/test/.local/bin/kitt-reverse-proxy'],
    with_ai_workers: false,
    portable: true,
  };

  const command = buildUpdateCommand(
    '/home/test/.local/share/kitt/installed-state.json',
    state,
    'reverse-proxy',
    'linux',
  );

  assert.match(command, /install\.sh.*sh -s --/);
  assert.match(command, /--modules.*reverse-proxy/);
  assert.match(command, /--root.*\/home\/test\/\.local\/share\/kitt/);
  assert.match(command, /--bin-dir.*\/home\/test\/\.local\/bin/);
  assert.match(command, /--portable/);
});

test('Windows update command uses PowerShell and keeps manual control', () => {
  const state: InstalledState = {
    requested_modules: ['reverse-proxy'],
    launchers: ['C:\\Users\\test\\AppData\\Local\\KITT\\bin\\kitt-reverse-proxy.cmd'],
  };

  const command = buildUpdateCommand(
    'C:\\Users\\test\\AppData\\Local\\KITT\\installed-state.json',
    state,
    'reverse-proxy',
    'win32',
  );

  assert.match(command, /Invoke-RestMethod/);
  assert.match(command, /--modules 'reverse-proxy'/);
  assert.match(command, /--root 'C:\\Users\\test\\AppData\\Local\\KITT'/);
});

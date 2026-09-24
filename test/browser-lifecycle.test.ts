import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  AppConfig,
  ChatExecutor,
  LiveBrowserSession
} from '../src/types.js';
import type { ProviderPreset } from '../src/providers/catalog.js';
import {
  createManagedUiRuntime,
  type UiBrowserLifecycleDeps
} from '../src/runtime/ui-browser-lifecycle.js';
import { ManualInterventionRequiredError } from '../src/runtime/ui-executor.js';

const provider = {
  id: 'chatgpt',
  name: 'ChatGPT',
  defaultApiModel: 'chatgpt-web',
  ui: {
    inputSelectors: ['textarea'],
    responseSelectors: [],
    sendSelectors: [],
    streamingSelectors: [],
    newChatUrl: 'https://chatgpt.com/'
  }
} as unknown as ProviderPreset;

const geminiProvider = {
  id: 'gemini',
  name: 'Gemini Web',
  defaultApiModel: 'gemini-web',
  ui: {
    inputSelectors: ['textarea'],
    responseSelectors: [],
    sendSelectors: [],
    streamingSelectors: [],
    newChatUrl: 'https://gemini.google.com/app',
    manualAuthBrowser: 'system-chrome',
    manualAuthUrl: 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fgemini.google.com%2Fapp'
  }
} as unknown as ProviderPreset;

function baseConfig(browserMode: AppConfig['browserMode']): AppConfig {
  return {
    targetUrl: 'https://chatgpt.com/',
    model: '',
    apiModel: 'chatgpt-web',
    ollamaUrl: 'http://127.0.0.1:11434/api/generate',
    host: '127.0.0.1',
    port: 3000,
    captureTimeoutMs: 120_000,
    settleAfterCandidateMs: 1_500,
    responseSampleTimeoutMs: 8_000,
    ollamaTimeoutMs: 60_000,
    upstreamTimeoutMs: 120_000,
    uiResponseTimeoutMs: 180_000,
    uiSettleMs: 1_200,
    manualInterventionTimeoutMs: 300_000,
    headed: browserMode === 'headed',
    browserMode,
    cors: true,
    userDataDir: '/tmp/kitt-test-profile',
    maxQueue: 64,
    minIntervalMs: 0,
    allowedEndpointHosts: [],
    followRedirects: false,
    maxSessions: 4,
    sessionIdleTimeoutMs: 1_800_000,
    logFormat: 'text',
    toolEnforcement: 'explore-first',
    provider: 'chatgpt',
    transport: 'ui'
  };
}

function session(id: string, headed: boolean, closed: string[]): LiveBrowserSession {
  return {
    context: {} as any,
    page: {} as any,
    persistent: true,
    headed,
    async close() {
      closed.push(id);
    }
  };
}

function executor(): ChatExecutor {
  return {
    modelId: 'chatgpt-web',
    transport: 'ui',
    async execute() {
      throw new Error('not used');
    },
    describe() {
      return {};
    }
  };
}

test('auto mode opens visible only for auth then returns headless', async () => {
  const opened: boolean[] = [];
  const closed: string[] = [];
  let openIndex = 0;
  const readiness = [false, true];
  const deps: UiBrowserLifecycleDeps = {
    async open(config) {
      opened.push(config.headed);
      openIndex += 1;
      return session(`s${openIndex}`, config.headed, closed);
    },
    async navigate() {},
    async ready() {
      return readiness.shift() ?? true;
    },
    async initialize() {
      return executor();
    },
    async pause() {}
  };

  const result = await createManagedUiRuntime(
    baseConfig('auto'),
    provider,
    deps
  );

  assert.deepEqual(opened, [false, true, false]);
  assert.deepEqual(closed, ['s1', 's2']);
  assert.equal(result.session.headed, false);
});

test('Gemini defers CDP automation until human Chrome login completes', async () => {
  const launches: Array<{ headed: boolean; mode: string; launchUrl?: string }> = [];
  const closed: string[] = [];
  let openIndex = 0;
  const readiness = [false, true];
  const deps: UiBrowserLifecycleDeps = {
    async open(config, launch) {
      launches.push({
        headed: config.headed,
        mode: launch?.mode || 'default',
        ...(launch?.launchUrl ? { launchUrl: launch.launchUrl } : {})
      });
      openIndex += 1;
      return session(`g${openIndex}`, config.headed, closed);
    },
    async navigate() {},
    async ready() {
      return readiness.shift() ?? true;
    },
    async initialize() {
      return executor();
    },
    async pause() {}
  };

  const config = {
    ...baseConfig('auto'),
    targetUrl: 'https://gemini.google.com/app',
    provider: 'gemini',
    apiModel: 'gemini-web'
  };

  const result = await createManagedUiRuntime(config, geminiProvider, deps);

  assert.deepEqual(launches, [
    { headed: false, mode: 'default' },
    {
      headed: true,
      mode: 'system-chrome-auth',
      launchUrl: 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fgemini.google.com%2Fapp'
    },
    { headed: false, mode: 'default' }
  ]);
  assert.deepEqual(closed, ['g1', 'g2']);
  assert.equal(result.session.headed, false);
});

test('strict headless never opens a visible authentication browser', async () => {
  const opened: boolean[] = [];
  const deps: UiBrowserLifecycleDeps = {
    async open(config) {
      opened.push(config.headed);
      return session('strict', config.headed, []);
    },
    async navigate() {},
    async ready() {
      return false;
    },
    async initialize() {
      return executor();
    },
    async pause() {}
  };

  await assert.rejects(
    createManagedUiRuntime(baseConfig('headless'), provider, deps),
    ManualInterventionRequiredError
  );
  assert.deepEqual(opened, [false]);
});

test('explicit headed mode keeps one visible browser', async () => {
  const opened: boolean[] = [];
  const closed: string[] = [];
  const deps: UiBrowserLifecycleDeps = {
    async open(config) {
      opened.push(config.headed);
      return session('headed', config.headed, closed);
    },
    async navigate() {},
    async ready() {
      throw new Error('probe must not run in headed mode');
    },
    async initialize() {
      return executor();
    },
    async pause() {}
  };

  const result = await createManagedUiRuntime(
    baseConfig('headed'),
    provider,
    deps
  );

  assert.deepEqual(opened, [true]);
  assert.deepEqual(closed, []);
  assert.equal(result.session.headed, true);
});

test('auto mode falls back to visible when authenticated headless is unusable', async () => {
  const opened: boolean[] = [];
  const closed: string[] = [];
  let openIndex = 0;
  const readiness = [false, false];
  const deps: UiBrowserLifecycleDeps = {
    async open(config) {
      opened.push(config.headed);
      openIndex += 1;
      return session(`f${openIndex}`, config.headed, closed);
    },
    async navigate() {},
    async ready() {
      return readiness.shift() ?? true;
    },
    async initialize() {
      return executor();
    },
    async pause() {}
  };

  const result = await createManagedUiRuntime(
    baseConfig('auto'),
    provider,
    deps
  );

  assert.deepEqual(opened, [false, true, false, true]);
  assert.deepEqual(closed, ['f1', 'f2', 'f3']);
  assert.equal(result.session.headed, true);
});

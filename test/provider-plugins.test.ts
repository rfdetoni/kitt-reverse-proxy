import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProviderPluginModules } from '../src/plugins/loader.js';
import { ProviderPluginRegistry } from '../src/plugins/registry.js';
import {
  PROVIDER_PLUGIN_API_VERSION,
  defineProviderPlugin,
  type ProviderPlugin
} from '../src/plugins/sdk.js';

function providerPlugin(id = 'acme'): ProviderPlugin {
  return defineProviderPlugin({
    apiVersion: PROVIDER_PLUGIN_API_VERSION,
    version: '1.0.0',
    provider: {
      id,
      name: 'Acme Web',
      hosts: ['chat.acme.test'],
      defaultApiModel: 'acme-web',
      preferredTransport: 'ui',
      transports: ['ui'],
      auth: 'browser-profile',
      capabilities: {
        streaming: true,
        tools: 'protocol',
        structuredOutput: 'best_effort',
        systemMessages: 'native-or-emulated',
        reasoning: false
      },
      models: [{ id: 'acme-web', aliases: ['acme'] }],
      ui: {
        selectorVersion: 1,
        inputSelectors: ['textarea'],
        sendSelectors: ['button[type="submit"]'],
        responseSelectors: ['[data-role="assistant"]'],
        streamingSelectors: [],
        newChatUrl: 'https://chat.acme.test/',
        supportsImageUpload: false
      }
    }
  });
}

test('provider plugin registry accepts SDK plugins and rejects id collisions', () => {
  const registry = new ProviderPluginRegistry();
  const plugin = providerPlugin();
  registry.register(plugin, 'test');
  assert.equal(registry.get('acme')?.defaultApiModel, 'acme-web');
  assert.deepEqual(registry.ids(), ['acme']);
  assert.throws(() => registry.register(providerPlugin(), 'duplicate'), /already registered/);
});

test('provider plugin loader imports only explicitly requested local modules', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kitt-provider-plugin-'));
  const modulePath = join(directory, 'provider.mjs');
  const rawPlugin = {
    apiVersion: 1,
    version: '1.2.3',
    provider: {
      id: 'external',
      name: 'External Web',
      hosts: ['external.test'],
      defaultApiModel: 'external-web',
      preferredTransport: 'ui',
      transports: ['ui'],
      auth: 'browser-profile',
      capabilities: {
        streaming: true,
        tools: 'protocol',
        structuredOutput: 'best_effort',
        systemMessages: 'native-or-emulated',
        reasoning: false
      },
      models: [{ id: 'external-web', aliases: [] }],
      ui: {
        selectorVersion: 1,
        inputSelectors: ['textarea'],
        sendSelectors: ['button'],
        responseSelectors: ['article'],
        streamingSelectors: [],
        supportsImageUpload: false
      }
    }
  };
  await writeFile(modulePath, `export default ${JSON.stringify(rawPlugin)};\n`, 'utf8');
  const registry = new ProviderPluginRegistry();

  try {
    const loaded = await loadProviderPluginModules([modulePath], { registry });
    assert.deepEqual(loaded.map((plugin) => plugin.provider.id), ['external']);
    assert.equal(registry.get('external')?.name, 'External Web');

    const secondLoad = await loadProviderPluginModules([modulePath], { registry });
    assert.deepEqual(secondLoad, []);
    assert.throws(
      () => registry.register(providerPlugin('external'), 'collision'),
      /already registered/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('provider plugin loader rejects remote and node protocol modules', async () => {
  const registry = new ProviderPluginRegistry();
  await assert.rejects(
    () => loadProviderPluginModules(['https://example.com/provider.mjs'], { registry }),
    /local files or installed npm packages/
  );
  await assert.rejects(
    () => loadProviderPluginModules(['node:fs'], { registry }),
    /local files or installed npm packages/
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, detectProvider } from '../src/providers/catalog.js';
import { DEFAULT_PROVIDER_PLUGINS } from '../src/plugins/default/index.js';
import { PROVIDER_PLUGIN_API_VERSION } from '../src/plugins/sdk.js';

test('provider manifests satisfy the v2 registry contract', () => {
  const ids = new Set<string>();
  for (const provider of PROVIDERS) {
    assert.equal(ids.has(provider.id), false, `duplicate provider id: ${provider.id}`);
    ids.add(provider.id);
    assert.ok(Number.isInteger(provider.ui.selectorVersion) && provider.ui.selectorVersion >= 1);
    assert.ok(provider.models.length > 0);
    assert.ok(provider.ui.inputSelectors.length > 0);
    assert.ok(provider.ui.sendSelectors.length > 0);
    assert.ok(provider.ui.responseSelectors.length > 0);
    assert.ok(provider.transports.includes(provider.preferredTransport));

    const modelIds = new Set<string>();
    for (const model of provider.models) {
      assert.ok(model.id.length > 0);
      assert.equal(modelIds.has(model.id), false, `duplicate model ${provider.id}/${model.id}`);
      modelIds.add(model.id);
    }

    if (provider.id === 'generic') {
      assert.deepEqual(provider.hosts, []);
      continue;
    }
    assert.ok(provider.ui.newChatUrl);
    const hostname = new URL(provider.ui.newChatUrl!).hostname;
    assert.ok(provider.hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`)));
    assert.equal(detectProvider(provider.ui.newChatUrl!).id, provider.id);
  }
});

test('Gemini declares human Chrome authentication without weakening browser security', () => {
  const gemini = PROVIDERS.find((provider) => provider.id === 'gemini');
  assert.ok(gemini);
  assert.equal(gemini.ui.manualAuthBrowser, 'system-chrome');
  assert.equal(new URL(gemini.ui.manualAuthUrl!).hostname, 'accounts.google.com');
});

test('provider selector packs do not contain duplicate selectors', () => {
  for (const provider of PROVIDERS) {
    for (const [kind, selectors] of Object.entries({
      input: provider.ui.inputSelectors,
      send: provider.ui.sendSelectors,
      response: provider.ui.responseSelectors,
      streaming: provider.ui.streamingSelectors
    })) {
      assert.equal(new Set(selectors).size, selectors.length, `${provider.id} has duplicate ${kind} selectors`);
    }
  }
});


test('default providers are packaged as SDK-compatible plugins', () => {
  assert.equal(DEFAULT_PROVIDER_PLUGINS.length, PROVIDERS.length);
  assert.deepEqual(
    DEFAULT_PROVIDER_PLUGINS.map((plugin) => plugin.provider.id),
    PROVIDERS.map((provider) => provider.id)
  );
  for (const plugin of DEFAULT_PROVIDER_PLUGINS) {
    assert.equal(plugin.apiVersion, PROVIDER_PLUGIN_API_VERSION);
    assert.match(plugin.version, /^\d+\.\d+\.\d+/);
    assert.equal(plugin.provider, PROVIDERS.find((provider) => provider.id === plugin.provider.id));
  }
});

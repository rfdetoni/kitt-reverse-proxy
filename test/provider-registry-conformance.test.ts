import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, detectProvider } from '../src/providers/catalog.js';

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

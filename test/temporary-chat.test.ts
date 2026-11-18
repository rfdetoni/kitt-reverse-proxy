import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from 'playwright';
import { activateTemporaryChat, temporaryChatMode } from '../src/runtime/temporary-chat.js';

function stub(verified: boolean): { page: Page; navigations: string[] } {
  const navigations: string[] = [];
  const page = {
    goto: async (url: string) => { navigations.push(url); },
    url: () => 'https://chatgpt.com/?temporary-chat=true',
    getByRole: (_role: string, _props: unknown) => ({
      first: () => ({
        waitFor: async () => { if (!verified) throw new Error('missing heading'); }
      })
    })
  } as unknown as Page;
  return { page, navigations };
}

test('temporary chat navigates and requires explicit provider UI confirmation', async () => {
  const { page, navigations } = stub(true);
  await activateTemporaryChat(page, 'chatgpt', 'required');
  assert.deepEqual(navigations, ['https://chatgpt.com/?temporary-chat=true']);
});

test('missing UI proof fails closed rather than sending a persistent conversation', async () => {
  const { page } = stub(false);
  await assert.rejects(activateTemporaryChat(page, 'chatgpt', 'supported'), /did not confirm/);
});

test('unsupported providers respect required and supported modes', async () => {
  const { page, navigations } = stub(false);
  await assert.rejects(activateTemporaryChat(page, 'claude', 'required'), /not verified/);
  await activateTemporaryChat(page, 'claude', 'supported');
  assert.equal(navigations.length, 0);
});

test('configuration is strict', () => {
  assert.equal(temporaryChatMode({ PROXY_TEMPORARY_CHAT: 'supported' }), 'supported');
  assert.throws(() => temporaryChatMode({ PROXY_TEMPORARY_CHAT: 'unknown' }));
});

import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildAgentEnvironment,
  buildJetBrainsEntries,
  installJetBrains,
  uninstallJetBrains
} from '../src/gateway/agent-gateway.js';

test('codex environment is pinned to KITT custom provider', () => {
  const env = buildAgentEnvironment('codex', {
    baseUrl: 'http://127.0.0.1:3000',
    openaiModel: 'chatgpt-web'
  }, {
    JETBRAINS_AI_TOKEN: 'must-disappear',
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    OPENAI_BASE_URL: 'https://api.openai.com/v1'
  });

  assert.equal(env.OPENAI_BASE_URL, 'http://127.0.0.1:3000/v1');
  assert.equal(env.JETBRAINS_AI_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.NO_BROWSER, '1');
  const config = JSON.parse(env.CODEX_CONFIG || '{}');
  assert.equal(config.model_provider, 'kitt');
  assert.equal(config.model_providers.kitt.base_url, 'http://127.0.0.1:3000/v1');
  assert.equal(config.model_providers.kitt.wire_api, 'responses');
});

test('claude environment is pinned to Anthropic-compatible KITT ingress', () => {
  const env = buildAgentEnvironment('claude', {
    baseUrl: 'http://localhost:3000',
    anthropicModel: 'claude-web'
  }, { OPENAI_BASE_URL: 'https://api.openai.com/v1' });

  assert.equal(env.ANTHROPIC_BASE_URL, 'http://localhost:3000');
  assert.equal(env.ANTHROPIC_MODEL, 'claude-web');
  assert.equal(env.OPENAI_BASE_URL, undefined);
});

test('non-loopback KITT endpoint is rejected', () => {
  assert.throws(
    () => buildAgentEnvironment('codex', { baseUrl: 'https://proxy.example.com' }, {}),
    /loopback/
  );
});

test('JetBrains entries use gateway executable as the launcher', () => {
  const entries = buildJetBrainsEntries('/opt/kitt/bin/kitt-reverse-proxy', {
    baseUrl: 'http://127.0.0.1:3000',
    openaiModel: 'chatgpt-web',
    anthropicModel: 'claude-web',
    opencode: true
  });
  assert.equal(entries['KITT · Codex']?.command, '/opt/kitt/bin/kitt-reverse-proxy');
  assert.equal(entries['KITT · Claude']?.args[0], 'agent');
  assert.equal(entries['KITT · OpenCode']?.args[1], 'opencode');
});

test('install preserves unrelated acp entries and uninstall removes only KITT', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kitt-gateway-'));
  const path = join(dir, 'acp.json');
  const original = {
    default_mcp_settings: { use_idea_mcp: true },
    agent_servers: {
      Existing: { command: '/bin/existing', args: [] }
    }
  };
  await import('node:fs/promises').then(({ writeFile }) =>
    writeFile(path, JSON.stringify(original), 'utf8')
  );

  await installJetBrains({
    path,
    executable: '/opt/kitt/kitt-reverse-proxy',
    codex: true,
    claude: true,
    opencode: false
  });

  let parsed = JSON.parse(await readFile(path, 'utf8'));
  assert.ok(parsed.agent_servers.Existing);
  assert.ok(parsed.agent_servers['KITT · Codex']);
  assert.ok(parsed.agent_servers['KITT · Claude']);

  await uninstallJetBrains({ path });
  parsed = JSON.parse(await readFile(path, 'utf8'));
  assert.ok(parsed.agent_servers.Existing);
  assert.equal(parsed.agent_servers['KITT · Codex'], undefined);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureLogger, logger, safeUrlForLog, sanitizeLogMessage } from '../src/logger.js';

test('signed URL query and fragment are redacted from logs', () => {
  assert.equal(safeUrlForLog('https://example.com/chat?token=secret#frag'), 'https://example.com/chat?[redacted]');
  const message = sanitizeLogMessage('request failed https://example.com/chat?sig=abc&x=1');
  assert.equal(message.includes('sig=abc'), false);
  assert.match(message, /\?\[redacted\]/);
});

test('level 2 writes full sanitized trace payloads to file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitt-proxy-log-'));
  const path = join(dir, 'trace.log');
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    configureLogger({ format: 'json', level: 2, file: path });
    logger.trace('trace.full', {
      prompt: 'create backend and frontend',
      api_key: 'super-secret',
      nested: { token: 'hidden', content: 'visible payload' },
      items: Array.from({ length: 40 }, (_, index) => ({ index }))
    });
    const rendered = readFileSync(path, 'utf8');
    assert.match(rendered, /trace\.full/);
    assert.match(rendered, /create backend and frontend/);
    assert.match(rendered, /visible payload/);
    assert.match(rendered, /"index":39/);
    assert.equal(rendered.includes('super-secret'), false);
    assert.equal(rendered.includes('hidden'), false);
    assert.match(rendered, /\[REDACTED\]/);
  } finally {
    configureLogger({ format: 'text', level: 0, file: '' });
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

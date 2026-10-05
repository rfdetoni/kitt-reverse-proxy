import test from 'node:test';
import assert from 'node:assert/strict';
import { configureLogger, logger } from '../src/logger.js';

test('full-content trace remains bounded for cyclic runtime objects', () => {
  const lines: string[] = [];
  const originalLog = console.log;
  const cyclic: Record<string, unknown> = { kind: 'runtime' };
  cyclic.self = cyclic;

  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };

  try {
    configureLogger({
      format: 'text',
      sink: 'stdout',
      level: 2,
      content: 'full',
      file: ''
    });

    assert.doesNotThrow(() => {
      logger.trace('cyclic.runtime', {
        body: { messages: [{ role: 'user', content: 'visible in full mode' }] },
        options: { lifecycle: cyclic }
      });
    });

    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /\[MAX_DEPTH\]/);
    assert.match(lines[0]!, /visible in full mode/);
  } finally {
    console.log = originalLog;
    configureLogger({
      format: 'text',
      sink: 'stdout',
      level: 0,
      content: 'metadata',
      file: ''
    });
  }
});

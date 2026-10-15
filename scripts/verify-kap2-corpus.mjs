// Compare the shipped proxy parser against the Protocol repo's authoritative
// valid/invalid corpus, checked out at an immutable SHA by CI.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseKAP2 } from '../dist/contracts/kap2.js';

const root = resolve(process.argv[2] ?? 'protocol-source/fixtures/kap2');
if (!existsSync(join(root, 'valid')) || !existsSync(join(root, 'invalid'))) {
  throw new Error('Authoritative Protocol KAP/2 corpus checkout is required');
}
let checked = 0;
for (const name of readdirSync(join(root, 'valid')).filter(n => n.endsWith('.k2'))) {
  const raw = readFileSync(join(root, 'valid', name), 'utf8');
  const expected = JSON.parse(readFileSync(join(root, 'valid', name.replace(/\.k2$/, '.json')), 'utf8'));
  const frame = parseKAP2(raw);
  assert.equal(frame.action, 'final_response', name);
  assert.deepEqual(JSON.parse(JSON.stringify(frame.content)), expected, name);
  checked++;
}
for (const name of readdirSync(join(root, 'invalid')).filter(n => n.endsWith('.k2'))) {
  const raw = readFileSync(join(root, 'invalid', name), 'utf8');
  const code = readFileSync(join(root, 'invalid', name.replace(/\.k2$/, '.err')), 'utf8').trim();
  assert.throws(() => parseKAP2(raw), error => error?.code === code, name + ': ' + code);
  checked++;
}
assert.ok(checked >= 30, 'Protocol corpus unexpectedly incomplete');
console.log('Proxy KAP/2 authoritative corpus:', checked, 'cases passed');

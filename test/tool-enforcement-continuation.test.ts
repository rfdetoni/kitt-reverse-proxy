import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isTaskContinuationRequest,
  resolveToolEnforcementTaskText,
  toolEnforcementTaskKey
} from '../src/runtime/tool-enforcement.js';

test('recognizes short execution confirmations as task continuations', () => {
  for (const text of [
    'faça isso',
    'Faça isso.',
    'pode fazer',
    'continue',
    'prossiga',
    'aplique isso',
    'do it',
    'go ahead',
    'apply it'
  ]) {
    assert.equal(isTaskContinuationRequest(text), true, text);
  }
});

test('does not classify substantive new requests as task continuations', () => {
  assert.equal(isTaskContinuationRequest('crie um novo projeto Angular com outro backend'), false);
  assert.equal(isTaskContinuationRequest('explique como funciona o reverse proxy'), false);
  assert.equal(isTaskContinuationRequest('qual é o status atual do repositório?'), false);
});

test('continuation keeps the original executable task text for enforcement', () => {
  const original = 'crie backend e frontend e implemente o projeto no workspace';
  const resolved = resolveToolEnforcementTaskText(original, 'faça isso');

  assert.match(resolved, /crie backend e frontend/);
  assert.match(resolved, /faça isso/);
});

test('continuation does not reset the enforcement task key', () => {
  const initial = [
    { role: 'user' as const, text: 'crie backend e frontend e implemente o projeto' }
  ];
  const continued = [
    ...initial,
    { role: 'assistant' as const, text: 'Posso fazer isso.' },
    { role: 'user' as const, text: 'faça isso' }
  ];

  assert.equal(toolEnforcementTaskKey(continued), toolEnforcementTaskKey(initial));
});

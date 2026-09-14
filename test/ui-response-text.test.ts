import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanUiResponseText } from '../src/runtime/ui-response-monitor.js';

const gemini = { id: 'gemini', name: 'Gemini Web' } as const;
const chatgpt = { id: 'chatgpt', name: 'ChatGPT Web' } as const;

test('strips Gemini Portuguese browser speaker chrome', () => {
  assert.equal(
    cleanUiResponseText('O Gemini disse:\nResposta direta', gemini as any),
    'Resposta direta'
  );
  assert.equal(
    cleanUiResponseText('Gemini respondeu: Resposta direta', gemini as any),
    'Resposta direta'
  );
});

test('strips provider English speaker chrome', () => {
  assert.equal(
    cleanUiResponseText('ChatGPT said: Direct answer', chatgpt as any),
    'Direct answer'
  );
});

test('does not strip another provider name or ordinary model content', () => {
  assert.equal(
    cleanUiResponseText('O Gemini disse: exemplo citado pelo modelo', chatgpt as any),
    'O Gemini disse: exemplo citado pelo modelo'
  );
  assert.equal(
    cleanUiResponseText('Resposta sem prefixo', gemini as any),
    'Resposta sem prefixo'
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatGptModelNotVerifiedError,
  modelRadioMatches,
  requiredExactChatGptModel
} from '../src/runtime/chatgpt-model-verification.js';

test('ChatGPT exact model aliases are parsed conservatively', () => {
  assert.equal(requiredExactChatGptModel('chatgpt-web'), undefined);
  assert.equal(requiredExactChatGptModel('gpt-6-sol'), 'gpt-6-sol');
  assert.equal(requiredExactChatGptModel('GPT-6-ASTRA'), 'gpt-6-astra');
  assert.equal(requiredExactChatGptModel('gpt-5.6-sol'), 'gpt-5.6-sol');
  assert.throws(() => requiredExactChatGptModel('gpt-7-sol'), ChatGptModelNotVerifiedError);
});

test('ChatGPT selected model validation requires exact version and family', () => {
  assert.equal(modelRadioMatches('GPT-6 Sol', 'gpt-6-sol'), true);
  assert.equal(modelRadioMatches('GPT 6 Astra', 'gpt-6-astra'), true);
  assert.equal(modelRadioMatches('GPT-5.6 Sol', 'gpt-5.6-sol'), true);
  assert.equal(modelRadioMatches('GPT-5.6 Sol', 'gpt-6-sol'), false);
  assert.equal(modelRadioMatches('Latest', 'gpt-6-sol'), false);
  assert.equal(modelRadioMatches('GPT-6 Sol Pro', 'gpt-6-sol'), false);
});

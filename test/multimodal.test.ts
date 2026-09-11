import test from 'node:test';
import assert from 'node:assert/strict';
import { describeProxyError } from '../src/core/errors.js';
import {
  AttachmentInputError,
  ProviderNoAttachmentSupportError,
  attachmentDescriptors,
  isPublicAttachmentAddress,
  isPublicImageAddress
} from '../src/runtime/multimodal.js';

test('multimodal SSRF guard rejects private/reserved addresses', () => {
  assert.equal(isPublicImageAddress('127.0.0.1'), false);
  assert.equal(isPublicAttachmentAddress('10.0.0.1'), false);
  assert.equal(isPublicAttachmentAddress('169.254.169.254'), false);
  assert.equal(isPublicAttachmentAddress('::1'), false);
  assert.equal(isPublicAttachmentAddress('8.8.8.8'), true);
});

test('multimodal accepts OpenAI input_file data parts', () => {
  const body = {
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'resuma o pdf' },
        {
          type: 'input_file',
          filename: 'documento.pdf',
          file_data: 'data:application/pdf;base64,JVBERi0xLjQK'
        }
      ]
    }]
  };
  assert.deepEqual(attachmentDescriptors(body), [{
    source: 'data',
    mimeType: undefined,
    filename: 'documento.pdf',
    kind: 'file'
  }]);
});

test('multimodal accepts remote input_file without treating it as an image', () => {
  const body = {
    messages: [{
      role: 'user',
      content: [{
        type: 'input_file',
        filename: 'dados.csv',
        file_url: 'https://example.com/dados.csv'
      }]
    }]
  };
  assert.deepEqual(attachmentDescriptors(body), [{
    source: 'url',
    mimeType: undefined,
    filename: 'dados.csv',
    kind: 'file'
  }]);
});

test('multimodal keeps legacy image_url compatibility', () => {
  const body = {
    messages: [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }]
    }]
  };
  assert.equal(attachmentDescriptors(body)[0]?.kind, 'image');
});

test('attachment failures are exposed as client errors', () => {
  assert.deepEqual(describeProxyError(new AttachmentInputError('arquivo inválido')), {
    status: 400,
    code: 'attachment_input_error',
    message: 'arquivo inválido'
  });
  assert.deepEqual(describeProxyError(new ProviderNoAttachmentSupportError()), {
    status: 400,
    code: 'provider_no_attachment_support',
    message: 'O provider ativo não oferece upload de arquivos no transporte UI.'
  });
});

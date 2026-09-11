import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import type { Page } from 'playwright';
import type { ProviderPreset } from '../providers/catalog.js';
import type { JsonObject } from '../types.js';

const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 40 * 1024 * 1024;
const MAX_REDIRECTS = 2;

const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const DOCUMENT_MIME = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/xml',
  'text/xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint'
]);
const ALLOWED_MIME = new Set([...IMAGE_MIME, ...DOCUMENT_MIME]);

interface AttachmentInput {
  source: 'url' | 'data';
  value: string;
  mimeType?: string;
  filename?: string;
  kind: 'image' | 'file';
}

interface UploadFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export interface AttachmentDescriptor {
  source: 'url' | 'data';
  mimeType?: string;
  filename?: string;
  kind: 'image' | 'file';
}

export class ProviderNoImageSupportError extends Error {
  constructor() {
    super('O provider ativo não oferece upload de imagens no transporte UI.');
    this.name = 'ProviderNoImageSupportError';
  }
}

export class ProviderNoAttachmentSupportError extends Error {
  constructor() {
    super('O provider ativo não oferece upload de arquivos no transporte UI.');
    this.name = 'ProviderNoAttachmentSupportError';
  }
}

export class ImageInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageInputError';
  }
}

export class AttachmentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentInputError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 192 && b === 0 && parts[2] === 2) return false;
  if (a === 198 && b === 51 && parts[2] === 100) return false;
  if (a === 203 && b === 0 && parts[2] === 113) return false;
  return true;
}

export function isPublicImageAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;
  const normalized = address.toLowerCase();
  if (normalized === '::' || normalized === '::1') return false;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false;
  if (/^fe[89ab]/u.test(normalized)) return false;
  if (normalized.startsWith('ff')) return false;
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  return mapped ? isPublicIpv4(mapped) : true;
}

export const isPublicAttachmentAddress = isPublicImageAddress;

async function resolvePublicAddress(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  if (isIP(hostname)) {
    if (!isPublicAttachmentAddress(hostname)) throw new AttachmentInputError('file_url aponta para endereço IP privado/reservado.');
    return { address: hostname, family: isIP(hostname) as 4 | 6 };
  }
  const entries = await lookup(hostname, { all: true, verbatim: true });
  const publicEntry = entries.find((entry) => isPublicAttachmentAddress(entry.address));
  if (!publicEntry) throw new AttachmentInputError('file_url não resolveu para endereço público permitido.');
  if (entries.some((entry) => !isPublicAttachmentAddress(entry.address))) {
    throw new AttachmentInputError('file_url possui resolução DNS ambígua envolvendo endereço privado/reservado.');
  }
  return { address: publicEntry.address, family: publicEntry.family as 4 | 6 };
}

function safeFilename(value: string | undefined, mimeType: string): string {
  const raw = (value || '').split(/[\\/]/u).at(-1)?.trim() || '';
  const sanitized = raw.replace(/[^A-Za-z0-9._ -]/gu, '_').slice(0, 180);
  if (sanitized && !sanitized.startsWith('.')) return sanitized;
  const extensionByMime: Record<string, string> = {
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'text/csv': 'csv',
    'application/json': 'json',
    'application/xml': 'xml',
    'text/xml': 'xml',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx'
  };
  return `kitt-attachment.${extensionByMime[mimeType] || 'bin'}`;
}

function assertMimeAllowed(mimeType: string): void {
  if (!ALLOWED_MIME.has(mimeType)) {
    throw new AttachmentInputError(`MIME de arquivo não permitido: ${mimeType || '(ausente)'}.`);
  }
}

async function downloadHttps(url: URL, filename?: string, redirects = 0): Promise<UploadFile> {
  if (url.protocol !== 'https:') throw new AttachmentInputError('file_url remoto deve usar HTTPS.');
  if (url.username || url.password) throw new AttachmentInputError('file_url não pode conter credenciais.');
  if (redirects > MAX_REDIRECTS) throw new AttachmentInputError('file_url excedeu o limite de redirects.');

  const { address } = await resolvePublicAddress(url.hostname);
  const result = await new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const request = https.request({
      protocol: 'https:',
      hostname: address,
      port: url.port ? Number(url.port) : 443,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      servername: url.hostname,
      headers: {
        Host: url.host,
        Accept: [...ALLOWED_MIME].join(','),
        'User-Agent': 'kitt-reverse-proxy/3'
      },
      timeout: 15_000
    }, (response) => {
      const contentLength = Number(response.headers['content-length'] || 0);
      if (Number.isFinite(contentLength) && contentLength > MAX_ATTACHMENT_BYTES) {
        response.destroy();
        reject(new AttachmentInputError(`Arquivo excede ${MAX_ATTACHMENT_BYTES} bytes.`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_ATTACHMENT_BYTES) {
          response.destroy(new AttachmentInputError(`Arquivo excede ${MAX_ATTACHMENT_BYTES} bytes.`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        status: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new AttachmentInputError('Timeout ao baixar file_url.')));
    request.on('error', reject);
    request.end();
  });

  if ([301, 302, 303, 307, 308].includes(result.status)) {
    const location = result.headers.location;
    if (!location) throw new AttachmentInputError('Redirect de file_url sem Location.');
    return downloadHttps(new URL(location, url), filename, redirects + 1);
  }
  if (result.status < 200 || result.status >= 300) {
    throw new AttachmentInputError(`Falha ao baixar file_url: HTTP ${result.status}.`);
  }
  const mimeType = String(result.headers['content-type'] || '').split(';', 1)[0]!.trim().toLowerCase();
  assertMimeAllowed(mimeType);
  const urlName = decodeURIComponent(url.pathname.split('/').at(-1) || '');
  return { name: safeFilename(filename || urlName, mimeType), mimeType, buffer: result.body };
}

function decodeDataUrl(value: string, filename?: string, fallbackMime?: string): UploadFile {
  const match = value.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) throw new AttachmentInputError('Data URL de arquivo inválida.');
  const mimeType = (match[1] || fallbackMime || '').toLowerCase();
  assertMimeAllowed(mimeType);
  const raw = match[2]!.replace(/\s+/g, '');
  if (raw.length > Math.ceil(MAX_ATTACHMENT_BYTES * 4 / 3) + 8) throw new AttachmentInputError('Arquivo base64 excede o limite.');
  const buffer = Buffer.from(raw, 'base64');
  if (buffer.length > MAX_ATTACHMENT_BYTES) throw new AttachmentInputError('Arquivo base64 excede o limite.');
  return { name: safeFilename(filename, mimeType), mimeType, buffer };
}

function rawBase64Data(value: string, mimeType: string, filename?: string): UploadFile {
  const normalizedMime = mimeType.toLowerCase();
  assertMimeAllowed(normalizedMime);
  const raw = value.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(raw)) throw new AttachmentInputError('Conteúdo base64 de arquivo inválido.');
  if (raw.length > Math.ceil(MAX_ATTACHMENT_BYTES * 4 / 3) + 8) throw new AttachmentInputError('Arquivo base64 excede o limite.');
  const buffer = Buffer.from(raw, 'base64');
  if (buffer.length > MAX_ATTACHMENT_BYTES) throw new AttachmentInputError('Arquivo base64 excede o limite.');
  return { name: safeFilename(filename, normalizedMime), mimeType: normalizedMime, buffer };
}

function partString(part: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = part[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function attachmentInputs(body: JsonObject): AttachmentInput[] {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const result: AttachmentInput[] = [];

  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part) || typeof part.type !== 'string') continue;
      const type = part.type;
      if (type === 'image_url' || type === 'input_image') {
        const imageUrl = typeof part.image_url === 'string'
          ? part.image_url
          : isRecord(part.image_url) && typeof part.image_url.url === 'string'
            ? part.image_url.url
            : partString(part, 'url', 'image_url');
        if (imageUrl) result.push({ source: imageUrl.startsWith('data:') ? 'data' : 'url', value: imageUrl, kind: 'image' });
      } else if (type === 'image_base64' && typeof part.data === 'string') {
        const mime = partString(part, 'media_type', 'mime_type') || 'image/png';
        result.push({ source: 'data', value: `data:${mime};base64,${part.data}`, mimeType: mime, kind: 'image' });
      } else if (type === 'input_file' || type === 'file') {
        const filename = partString(part, 'filename', 'name');
        const fileUrl = partString(part, 'file_url', 'url');
        const fileData = partString(part, 'file_data', 'data');
        const mimeType = partString(part, 'media_type', 'mime_type');
        if (fileData) {
          const value = fileData.startsWith('data:')
            ? fileData
            : mimeType
              ? `data:${mimeType};base64,${fileData}`
              : fileData;
          result.push({ source: 'data', value, filename, mimeType, kind: 'file' });
        } else if (fileUrl) {
          result.push({ source: fileUrl.startsWith('data:') ? 'data' : 'url', value: fileUrl, filename, mimeType, kind: 'file' });
        }
      }
    }
  }
  if (result.length > MAX_ATTACHMENTS) throw new AttachmentInputError(`Máximo de ${MAX_ATTACHMENTS} arquivos por request.`);
  return result;
}

export function attachmentDescriptors(body: JsonObject): AttachmentDescriptor[] {
  return attachmentInputs(body).map(({ source, mimeType, filename, kind }) => ({ source, mimeType, filename, kind }));
}

function providerCanUpload(provider: ProviderPreset, attachments: AttachmentInput[]): boolean {
  if (!provider.ui.uploadSelector) return false;
  if (attachments.every((attachment) => attachment.kind === 'image')) return provider.ui.supportsImageUpload;
  return true;
}

export async function uploadAttachmentsFromBody(
  page: Page,
  provider: ProviderPreset,
  body: JsonObject
): Promise<string[]> {
  const attachments = attachmentInputs(body);
  if (!attachments.length) return [];
  if (!providerCanUpload(provider, attachments)) {
    if (attachments.every((attachment) => attachment.kind === 'image')) throw new ProviderNoImageSupportError();
    throw new ProviderNoAttachmentSupportError();
  }

  const selector = provider.ui.uploadSelector!;
  const locator = page.locator(selector).first();
  const hasInput = await locator.count().then((count) => count > 0).catch(() => false);

  if (!hasInput) {
    const publicImageUrls = attachments
      .filter((attachment) => attachment.kind === 'image' && attachment.source === 'url')
      .map((attachment) => attachment.value);
    if (publicImageUrls.length !== attachments.length) {
      throw new AttachmentInputError('O provider declara suporte a upload, mas o input de arquivo não foi localizado para conteúdo inline/documento.');
    }
    return publicImageUrls;
  }

  const uploads: UploadFile[] = [];
  let totalBytes = 0;
  for (const attachment of attachments) {
    let upload: UploadFile;
    if (attachment.source === 'url') {
      upload = await downloadHttps(new URL(attachment.value), attachment.filename);
    } else if (attachment.value.startsWith('data:')) {
      upload = decodeDataUrl(attachment.value, attachment.filename, attachment.mimeType);
    } else if (attachment.mimeType) {
      upload = rawBase64Data(attachment.value, attachment.mimeType, attachment.filename);
    } else {
      throw new AttachmentInputError('input_file inline precisa informar MIME via data URL, media_type ou mime_type.');
    }
    totalBytes += upload.buffer.length;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new AttachmentInputError(`Total de anexos excede ${MAX_TOTAL_ATTACHMENT_BYTES} bytes.`);
    }
    uploads.push(upload);
  }

  await locator.setInputFiles(uploads);
  return [];
}

/** Backward-compatible image-only entry point. */
export async function uploadImagesFromBody(
  page: Page,
  provider: ProviderPreset,
  body: JsonObject
): Promise<string[]> {
  return uploadAttachmentsFromBody(page, provider, body);
}

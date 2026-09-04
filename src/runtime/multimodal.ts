import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import type { Page } from 'playwright';
import type { ProviderPreset } from '../providers/catalog.js';
import type { JsonObject } from '../types.js';

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 2;
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

interface ImageInput {
  source: 'url' | 'data';
  value: string;
  mimeType?: string;
}

interface UploadFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export class ProviderNoImageSupportError extends Error {
  constructor() {
    super('O provider ativo não oferece upload de imagens no transporte UI.');
    this.name = 'ProviderNoImageSupportError';
  }
}

export class ImageInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageInputError';
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

async function resolvePublicAddress(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  if (isIP(hostname)) {
    if (!isPublicImageAddress(hostname)) throw new ImageInputError('image_url aponta para endereço IP privado/reservado.');
    return { address: hostname, family: isIP(hostname) as 4 | 6 };
  }
  const entries = await lookup(hostname, { all: true, verbatim: true });
  const publicEntry = entries.find((entry) => isPublicImageAddress(entry.address));
  if (!publicEntry) throw new ImageInputError('image_url não resolveu para endereço público permitido.');
  if (entries.some((entry) => !isPublicImageAddress(entry.address))) {
    throw new ImageInputError('image_url possui resolução DNS ambígua envolvendo endereço privado/reservado.');
  }
  return { address: publicEntry.address, family: publicEntry.family as 4 | 6 };
}

async function downloadHttps(url: URL, redirects = 0): Promise<UploadFile> {
  if (url.protocol !== 'https:') throw new ImageInputError('image_url remoto deve usar HTTPS.');
  if (url.username || url.password) throw new ImageInputError('image_url não pode conter credenciais.');
  if (redirects > MAX_REDIRECTS) throw new ImageInputError('image_url excedeu o limite de redirects.');

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
        Accept: 'image/png,image/jpeg,image/webp,image/gif',
        'User-Agent': 'kitt-reverse-proxy/3'
      },
      timeout: 15_000
    }, (response) => {
      const contentLength = Number(response.headers['content-length'] || 0);
      if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
        response.destroy();
        reject(new ImageInputError(`Imagem excede ${MAX_IMAGE_BYTES} bytes.`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_IMAGE_BYTES) {
          response.destroy(new ImageInputError(`Imagem excede ${MAX_IMAGE_BYTES} bytes.`));
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
    request.on('timeout', () => request.destroy(new ImageInputError('Timeout ao baixar image_url.')));
    request.on('error', reject);
    request.end();
  });

  if ([301, 302, 303, 307, 308].includes(result.status)) {
    const location = result.headers.location;
    if (!location) throw new ImageInputError('Redirect de image_url sem Location.');
    return downloadHttps(new URL(location, url), redirects + 1);
  }
  if (result.status < 200 || result.status >= 300) {
    throw new ImageInputError(`Falha ao baixar image_url: HTTP ${result.status}.`);
  }
  const mimeType = String(result.headers['content-type'] || '').split(';', 1)[0]!.trim().toLowerCase();
  if (!ALLOWED_MIME.has(mimeType)) throw new ImageInputError(`MIME de imagem não permitido: ${mimeType || '(ausente)'}.`);
  const ext = mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/')[1] || 'img';
  return { name: `kitt-image.${ext}`, mimeType, buffer: result.body };
}

function decodeDataUrl(value: string): UploadFile {
  const match = value.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) throw new ImageInputError('Data URL de imagem inválida ou MIME não permitido.');
  const mimeType = match[1]!.toLowerCase();
  const raw = match[2]!.replace(/\s+/g, '');
  if (raw.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8) throw new ImageInputError('Imagem base64 excede o limite.');
  const buffer = Buffer.from(raw, 'base64');
  if (buffer.length > MAX_IMAGE_BYTES) throw new ImageInputError('Imagem base64 excede o limite.');
  const ext = mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/')[1] || 'img';
  return { name: `kitt-image.${ext}`, mimeType, buffer };
}

function imageInputs(body: JsonObject): ImageInput[] {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const result: ImageInput[] = [];

  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part) || typeof part.type !== 'string') continue;
      if (part.type === 'image_url' || part.type === 'input_image') {
        const imageUrl = typeof part.image_url === 'string'
          ? part.image_url
          : isRecord(part.image_url) && typeof part.image_url.url === 'string'
            ? part.image_url.url
            : typeof part.url === 'string'
              ? part.url
              : undefined;
        if (imageUrl) result.push({ source: imageUrl.startsWith('data:') ? 'data' : 'url', value: imageUrl });
      } else if (part.type === 'image_base64' && typeof part.data === 'string') {
        const mime = typeof part.media_type === 'string' ? part.media_type : typeof part.mime_type === 'string' ? part.mime_type : 'image/png';
        result.push({ source: 'data', value: `data:${mime};base64,${part.data}`, mimeType: mime });
      }
    }
  }
  if (result.length > MAX_IMAGES) throw new ImageInputError(`Máximo de ${MAX_IMAGES} imagens por request.`);
  return result;
}

export async function uploadImagesFromBody(
  page: Page,
  provider: ProviderPreset,
  body: JsonObject
): Promise<string[]> {
  const images = imageInputs(body);
  if (!images.length) return [];
  if (!provider.ui.supportsImageUpload) throw new ProviderNoImageSupportError();

  const selector = provider.ui.uploadSelector;
  const locator = selector ? page.locator(selector).first() : undefined;
  const hasInput = locator ? await locator.count().then((count) => count > 0).catch(() => false) : false;

  if (!hasInput) {
    const publicUrls = images.filter((image) => image.source === 'url').map((image) => image.value);
    if (publicUrls.length !== images.length) {
      throw new ImageInputError('O provider declara suporte a imagem, mas o input de upload não foi localizado para conteúdo base64.');
    }
    return publicUrls;
  }

  const uploads: UploadFile[] = [];
  for (const image of images) {
    uploads.push(image.source === 'data' ? decodeDataUrl(image.value) : await downloadHttps(new URL(image.value)));
  }

  await locator!.setInputFiles(uploads);
  return [];
}

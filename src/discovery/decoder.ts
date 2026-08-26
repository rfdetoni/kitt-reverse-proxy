import type { JsonValue } from '../types.js';

const MAX_BODY_BYTES = 5 * 1024 * 1024;

function parseJson(text: string): JsonValue | null {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return null;
  }
}

function stripXssi(text: string): string {
  return text.replace(/^\s*\)\]\}'\s*\r?\n?/, '').trim();
}

function parseSse(text: string): JsonValue {
  const events: JsonValue[] = [];
  const blocks = text.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());
    if (dataLines.length === 0) continue;
    const data = dataLines.join('\n');
    if (!data || data === '[DONE]') continue;
    events.push(parseJson(data) ?? data);
  }
  return { eventStream: events };
}

function parseNdjson(text: string): JsonValue {
  const events = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 10_000)
    .map((line) => parseJson(line) ?? line);
  return { ndjson: events };
}

function parseLengthFramedJson(text: string): JsonValue | null {
  const clean = stripXssi(text);
  const parsedWhole = parseJson(clean);
  if (parsedWhole !== null) return parsedWhole;

  const frames: JsonValue[] = [];
  const lines = clean.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines.slice(0, 20_000)) {
    if (/^\d+$/.test(line)) continue;
    const parsed = parseJson(line);
    if (parsed !== null) frames.push(parsed);
  }
  if (!frames.length) return null;
  return frames.length === 1 ? frames[0]! : { frames };
}

export function decodeTextBody(text: string, contentType: string): JsonValue {
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new Error(`Resposta excede ${MAX_BODY_BYTES} bytes.`);
  if (!text) return {};
  if (/text\/event-stream/i.test(contentType)) return parseSse(text);
  if (/ndjson|json-seq/i.test(contentType)) return parseNdjson(text);

  const framed = parseLengthFramedJson(text);
  if (framed !== null) return framed;
  return { text };
}

/** Validate raw JSON before JSON.parse can erase duplicate object keys. */
export function strictJson(raw: string | Uint8Array): unknown {
  const text = typeof raw === 'string' ? raw : new TextDecoder('utf-8', { fatal: true }).decode(raw);
  if (new TextEncoder().encode(text).length > 1024 * 1024) throw new Error('frame_too_large');
  const parsed: unknown = JSON.parse(text);
  let cursor = 0;
  const space = (): void => { while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor++; };
  const string = (): string => {
    const start = cursor++;
    while (cursor < text.length) {
      const char = text[cursor++];
      if (char === '\\') cursor++;
      else if (char === '"') {
        const decoded = JSON.parse(text.slice(start, cursor)) as string;
        if (/[\uD800-\uDFFF]/u.test(decoded)) throw new Error('unpaired Unicode surrogate');
        return decoded;
      }
    }
    throw new Error('invalid JSON string');
  };
  const value = (depth: number, path: string[] = []): void => {
    if (depth > 128) throw new Error('JSON nesting limit exceeded');
    space();
    if (text[cursor] === '{') {
      cursor++; space();
      const keys = new Set<string>();
      while (text[cursor] !== '}') {
        const key = string();
        if (keys.has(key)) throw new Error('duplicate JSON field');
        keys.add(key); space(); cursor++; value(depth + 1, [...path, key]); space();
        if (text[cursor] !== ',') break;
        cursor++; space();
      }
      cursor++;
    } else if (text[cursor] === '[') {
      cursor++; space();
      while (text[cursor] !== ']') {
        value(depth + 1, [...path, '*']); space();
        if (text[cursor] !== ',') break;
        cursor++;
      }
      cursor++;
    } else if (text[cursor] === '"') string();
    else {
      const start = cursor;
      while (cursor < text.length && !/[\s,}\]]/.test(text[cursor])) cursor++;
      const token: unknown = JSON.parse(text.slice(start, cursor));
      if (typeof token === 'number' && !Number.isFinite(token)) throw new Error('non-finite JSON number');
      if (['version', 'envelope.version'].includes(path.join('.')) && typeof token === 'number' && !/^-?\d+$/.test(text.slice(start, cursor))) throw new Error('protocol version must be an integer token');
    }
  };
  value(0);
  return parsed;
}

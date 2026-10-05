/** Bounded, lossless recovery of a single complete JSON payload. No schema guesses. */
export class ContractJsonError extends Error {
  constructor(public readonly kind: 'syntax' | 'ambiguous' | 'limit', message: string, public readonly offset = 0) {
    super(`${message} (offset ${offset})`);
    this.name = 'ContractJsonError';
  }
}

export function unwrapContractJson(text: string): string {
  const value = text.trim();
  const fenced = value.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/iu);
  if (fenced) return fenced[1]!.trim();
  const labeled = value.match(/^json[ \t]*\r?\n([\s\S]+)$/iu);
  return labeled ? labeled[1]!.trim() : value;
}

interface Parsed { value: unknown; end: number; }
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_WORK = 4_000_000;
const MAX_BRANCHES = 256;
const MAX_DEPTH = 64;
const STRING_ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

export function parseContractJson(text: string, onMember?: (key: string, value: unknown, path: string) => void): { value: unknown; text: string; repaired: boolean } {
  const source = unwrapContractJson(text);
  if (Buffer.byteLength(source, 'utf8') > MAX_BYTES) throw new ContractJsonError('limit', 'JSON payload exceeds 2 MiB');
  let work = 0;
  let branches = 0;
  let furthest = 0;
  const tick = (offset: number): void => {
    furthest = Math.max(furthest, offset);
    if (++work > MAX_WORK) throw new ContractJsonError('limit', 'JSON recovery work budget exhausted', offset);
  };
  const skip = (offset: number): number => {
    while (offset < source.length) {
      tick(offset);
      if (/\s/u.test(source[offset]!)) { offset++; continue; }
      if (source.startsWith('//', offset)) {
        offset = source.indexOf('\n', offset + 2);
        if (offset < 0) return source.length;
        continue;
      }
      if (source.startsWith('/*', offset)) {
        const end = source.indexOf('*/', offset + 2);
        if (end < 0) throw new ContractJsonError('syntax', 'Unterminated JSON comment', offset);
        offset = end + 2; continue;
      }
      break;
    }
    return offset;
  };
  const startsValue = (offset: number): boolean => /[\{\["'“\-0-9]/u.test(source[offset] ?? '')
    || /^(?:true|false|null)(?=\s|[,}\]])/u.test(source.slice(offset, offset + 6));
  const startsMember = (offset: number): boolean => {
    const first = source[offset];
    if (first !== '"' && first !== "'" && first !== '“') {
      return /^[A-Za-z_$][\w$.-]{0,255}\s*:/u.test(source.slice(offset, offset + 260));
    }
    const closing = first === '“' ? '”' : first;
    for (let index = offset + 1; index < Math.min(source.length, offset + 258); index++) {
      tick(index);
      if (source[index] === '\\') { index++; continue; }
      if (source[index] === closing) return source[skip(index + 1)] === ':';
    }
    return false;
  };
  function* string(start: number, key: boolean): Generator<Parsed> {
    const opening = source[start]!;
    const closing = opening === '“' ? '”' : opening;
    let value = '';
    let rawQuote = false;
    for (let index = start + 1; index < source.length; index++) {
      tick(index);
      const char = source[index]!;
      if (char === closing) {
        const next = skip(index + 1);
        const boundary = key ? source[next] === ':' || startsValue(next)
          : next === source.length || ',}]'.includes(source[next]!) || startsMember(next) || (next > index + 1 && startsValue(next));
        if (boundary) {
          if (rawQuote && ++branches > MAX_BRANCHES) throw new ContractJsonError('limit', 'JSON recovery branch budget exhausted', index);
          yield { value, end: index + 1 };
          // A correctly delimited string is immutable. Only a previously observed
          // raw quote permits alternative endings, which must be unambiguous.
          if (!rawQuote || key) return;
        }
        if (key) return;
        rawQuote = true;
        value += char;
        continue;
      }
      if (char === '\\') {
        const next = source[index + 1];
        if (next === undefined) return;
        if (next === closing && opening !== '"') { value += closing; index++; continue; }
        if (Object.hasOwn(STRING_ESCAPES, next)) { value += STRING_ESCAPES[next]; index++; continue; }
        if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(source.slice(index + 2, index + 6))) {
          value += String.fromCharCode(parseInt(source.slice(index + 2, index + 6), 16)); index += 5; continue;
        }
        // Non-JSON source escapes such as \\x00/\\d retain the literal backslash.
        value += '\\'; continue;
      }
      value += char;
    }
  }
  function* value(offset: number, depth: number, path: string): Generator<Parsed> {
    const start = skip(offset);
    tick(start);
    if (depth > MAX_DEPTH) throw new ContractJsonError('limit', 'JSON nesting limit exceeded', start);
    const char = source[start];
    if (char === '"' || char === "'" || char === '“') { yield* string(start, false); return; }
    if (char === '{' || char === '[') { yield* container(start + 1, depth + 1, char === '{', char === '{' ? {} : [], path); return; }
    const token = source.slice(start).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u)?.[0];
    if (!token) return;
    const end = skip(start + token.length);
    if (end < source.length && !',}]'.includes(source[end]!)
      && !(end > start + token.length && startsValue(end))) return;
    const parsed: unknown = JSON.parse(token);
    if (typeof parsed === 'number' && !Number.isFinite(parsed)) return;
    yield { value: parsed, end: start + token.length };
  }
  function* container(offset: number, depth: number, object: boolean, initial: Record<string, unknown> | unknown[], path: string): Generator<Parsed> {
    const pending = [{ offset, current: initial }];
    while (pending.length) {
      const state = pending.pop()!;
      const current = state.current;
      const start = skip(state.offset);
      tick(start);
      const close = object ? '}' : ']';
      if (source[start] === close) { yield { value: current, end: start + 1 }; continue; }
      if (Object.keys(current).length >= 2048) throw new ContractJsonError('limit', 'JSON container member limit exceeded', start);
      const keys: Parsed[] = [];
      if (object) {
        if ('"\'“'.includes(source[start] ?? '\0')) keys.push(...string(start, true));
        else {
          const key = source.slice(start).match(/^[A-Za-z_$][\w$.-]*(?=\s*:)/u)?.[0];
          if (key) keys.push({ value: key, end: start + key.length });
        }
      } else keys.push({ value: '', end: start });
      for (const key of keys) {
        const name = String(key.value);
        if (object && Object.hasOwn(current, name)) throw new ContractJsonError('ambiguous', `Duplicate property ${JSON.stringify(name)}`, start);
        const colon = skip(key.end);
        if (object && source[colon] !== ':' && !startsValue(colon)) continue;
        const childPath = path + '/' + (object ? name.replace(/~/g, '~0').replace(/\//g, '~1') : String((current as unknown[]).length));
        for (const child of value(object ? colon + (source[colon] === ':' ? 1 : 0) : start, depth, childPath)) {
          if (object) onMember?.(name, child.value, childPath);
          const next = object ? { ...current, [name]: child.value } : [...current as unknown[], child.value];
          const end = skip(child.end);
          if (source[end] === close) { yield { value: next, end: end + 1 }; continue; }
          if (source[end] === ',') pending.push({ offset: end + 1, current: next });
          else if (object ? startsMember(end) : startsValue(end)) pending.push({ offset: end, current: next });
          if (pending.length > MAX_BRANCHES) throw new ContractJsonError('limit', 'JSON recovery state budget exhausted', end);
        }
      }
    }
  }
  let parsed: unknown;
  let found = false;
  for (const candidate of value(0, 0, '$')) {
    if (skip(candidate.end) !== source.length) continue;
    if (found) throw new ContractJsonError('ambiguous', 'Multiple possible JSON interpretations', candidate.end);
    parsed = candidate.value;
    found = true;
  }
  if (!found) throw new ContractJsonError('syntax', 'Incomplete or invalid single JSON payload', furthest);
  const canonical = JSON.stringify(parsed);
  // Compare against JSON.parse only after checking duplicate keys and limits.
  let repaired = true;
  try { repaired = JSON.stringify(JSON.parse(source)) !== canonical; } catch { /* locally repaired */ }
  return { value: parsed, text: canonical, repaired };
}

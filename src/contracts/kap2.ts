/** Strict KAP/2 wire syntax. Authorization remains host-owned. */
import { KAPError } from './kap-error.js';
import { strictJson } from './strict-json.js';
import type { KAPMessage } from './kap.js';
const MAX_SIZE = 65536, MAX_LINES = 3000, MAX_DEPTH = 20, MAX_ROWS = 1024;
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEY_TOKEN = '(?:"(?:[^"\\\\]|\\\\.)*"|[A-Za-z_][A-Za-z0-9_]*)';
const FIELD = new RegExp('^(' + KEY_TOKEN + ')(?:\\[([0-9]+)\\](?:\\{(.+)\\})?)?:(?: (.*))?$');
const LITERAL = new RegExp('^(' + KEY_TOKEN + ')<<([A-Z_][A-Z0-9_]{0,24})(?::([0-9]+))?$');
const INTEGER = /^-?(?:0|[1-9][0-9]*)$/, DECIMAL = /^-?(?:0|[1-9][0-9]*)\.[0-9]+$/;
const DENIED = new Set(['__proto__', 'prototype', 'constructor']);
const utf8 = new TextEncoder();
export class KAP2Error extends KAPError {
  constructor(message: string, code = 'E_FIELD', line?: number) {
    super(message, code, line);
    this.name = 'KAP2Error';
  }
}
function fail(message: string, code = 'E_FIELD', line?: number): never { throw new KAP2Error(message, code, line); }
function safe(text: string, line?: number, literal = false): void {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) fail('Invalid Unicode', 'E_UTF8', line);
    if ((cp < 32 && !(literal && (cp === 9 || cp === 10))) || cp === 127) fail('Invalid control', 'E_SCALAR', line);
  }
}
function structure(text: string, n: number): void {
  if (text.includes('\t')) fail('KAP/2 tabs forbidden', 'E_TAB', n);
  if (text.endsWith(' ')) fail('KAP/2 trailing whitespace', 'E_WHITESPACE', n);
  safe(text, n);
}
function key(token: string, n: number): string {
  let name = token;
  if (token.startsWith('"')) {
    try { name = JSON.parse(token) as string; } catch { fail('Invalid quoted key', 'E_FIELD', n); }
    if (typeof name !== 'string') fail('Invalid quoted key', 'E_FIELD', n);
  } else if (!KEY.test(token)) fail('Invalid key', 'E_FIELD', n);
  safe(name, n);
  if (DENIED.has(name)) fail('Unsafe key', 'E_KEY_UNSAFE', n);
  return name;
}
type Cell = { value: string; quoted: boolean };
function csv(text: string, n: number): Cell[] {
  const out: Cell[] = [];
  let i = 0;
  while (i <= text.length) {
    const start = i;
    if (text[i] === '"') {
      i++;
      let value = '', closed = false;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') { value += '"'; i += 2; }
          else { i++; closed = true; break; }
        } else value += text[i++]!;
      }
      if (!closed || (i < text.length && text[i] !== ',')) fail('Invalid CSV quote', 'E_SCALAR', n);
      safe(value, n);
      out.push({value, quoted: true});
    } else {
      while (i < text.length && text[i] !== ',') {
        if (text[i] === '"') fail('Invalid CSV quote', 'E_SCALAR', n);
        i++;
      }
      const value = text.slice(start, i).trim();
      safe(value, n);
      out.push({value, quoted: false});
    }
    if (i === text.length) break;
    i++;
  }
  return out;
}
type Schema = Record<string, unknown> | undefined;
function record(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function types(s?: Schema): Set<string> {
  if (!s) return new Set();
  if (typeof s.type === 'string') return new Set([s.type]);
  if (Array.isArray(s.type) && s.type.every(v => typeof v === 'string')) return new Set(s.type as string[]);
  for (const field of ['anyOf', 'oneOf']) {
    const children = s[field];
    if (Array.isArray(children) && children.length && children.every(v => record(v) && 'type' in v)) {
      const answer = new Set<string>();
      for (const v of children as Schema[]) for (const t of types(v)) answer.add(t);
      return answer;
    }
  }
  return new Set();
}
function child(s?: Schema, field?: string): Schema {
  if (!s) return undefined;
  if (field === undefined) return record(s.items) ? s.items : undefined;
  const props = s.properties;
  if (record(props) && record(props[field])) return props[field] as Schema;
  return record(s.additionalProperties) ? s.additionalProperties : undefined;
}
function atom(input: string, n: number, schema?: Schema, quoted = false): unknown {
  if (quoted) { safe(input, n); return input; }
  if (input.startsWith('"')) {
    let value: unknown;
    try { value = JSON.parse(input); } catch { fail('Invalid quoted scalar', 'E_SCALAR', n); }
    if (typeof value !== 'string') fail('Quoted scalar must be a string', 'E_SCALAR', n);
    safe(value, n);
    return value;
  }
  safe(input, n);
  if (input === '-0' || (DECIMAL.test(input) && input.startsWith('-') && Number(input) === 0))
    fail('Negative zero forbidden', 'E_SCALAR', n);
  let val: unknown = input, kind = 'string';
  if (input === 'null') { val = null; kind = 'null'; }
  else if (input === 'true' || input === 'false') { val = input === 'true'; kind = 'boolean'; }
  else if (INTEGER.test(input)) {
    val = Number(input); kind = 'integer';
    if (!Number.isSafeInteger(val)) fail('Unsafe integer', 'E_NUMBER_RANGE', n);
  } else if (DECIMAL.test(input)) {
    val = Number(input); kind = 'number';
    if (!Number.isFinite(val)) fail('Nonfinite decimal', 'E_NUMBER_RANGE', n);
  }
  const allowed = types(schema);
  if (kind !== 'string' && allowed.has('string') && !allowed.has(kind) && !(kind === 'integer' && allowed.has('number'))) return input;
  return val;
}
function linesOf(raw: string): string[] {
  if (typeof raw !== 'string') fail('Invalid input', 'E_UTF8');
  if (utf8.encode(raw).length > MAX_SIZE) fail('Frame too large', 'E_SIZE');
  if (raw.includes('\ufeff')) fail('BOM forbidden', 'E_UTF8');
  const lines = raw.replace(/^[ \r\n]+|[ \r\n]+$/g, '').split('\n').map(x => x.endsWith('\r') ? x.slice(0, -1) : x);
  if (lines.length > MAX_LINES) fail('Too many lines', 'E_LINES');
  return lines;
}

function compactJsonFinal(raw: string): KAPMessage | undefined {
  if (!raw.startsWith('K2 F')) return undefined;
  const marker = /^K2 F(?: |\r?\n)@json: /.exec(raw);
  if (!marker) {
    if (/^K2 F(?: |\r?\n)@json:/.test(raw)) fail('Malformed compact frame', 'E_COMPACT_JSON');
    return undefined;
  }
  const payloadWithEnd = raw.slice(marker[0].length);
  const terminator = /(?: |\r?\n)K2\/END$/.exec(payloadWithEnd);
  if (!terminator) fail('Missing compact terminator', 'E_TERMINATOR');
  const payload = payloadWithEnd.slice(0, terminator.index);
  if (/[\r\n]/.test(payload)) fail('Compact JSON requires one physical line', 'E_COMPACT_JSON');
  let parsed: unknown;
  try { parsed = strictJson(payload); }
  catch (error) {
    if (error instanceof Error && error.message === 'duplicate JSON field')
      fail('Duplicate compact JSON key', 'E_KEY_DUPLICATE');
    fail('Invalid compact JSON', 'E_COMPACT_JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
      || !Object.keys(parsed).length) fail('Compact final requires non-empty object', 'E_COMPACT_JSON');
  function inspect(value: unknown, depth = 0): void {
    if (depth > MAX_DEPTH) fail('Compact depth exceeded', 'E_DEPTH');
    if (Array.isArray(value)) {
      if (value.length > MAX_ROWS) fail('Compact array too large', 'E_ARRAY_SIZE');
      for (const item of value) inspect(item, depth + 1);
    } else if (value && typeof value === 'object') {
      if (Object.keys(value).length > MAX_ROWS) fail('Compact object too large', 'E_ARRAY_SIZE');
      for (const [name, item] of Object.entries(value)) {
        if (DENIED.has(name)) fail('Unsafe compact key', 'E_KEY_UNSAFE');
        safe(name);
        inspect(item, depth + 1);
      }
    } else if (typeof value === 'string') safe(value, undefined, true);
    else if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('Non-finite compact number', 'E_NUMBER_RANGE');
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) fail('Unsafe compact integer', 'E_NUMBER_RANGE');
    }
  }
  inspect(parsed);
  return {action:'final_response',tool:null,tool_input:null,
    content:parsed as Record<string, unknown>,reasoning_summary:'',loop:null};
}

export function parseKAP2(raw: string, options: {schema?: Schema} = {}): KAPMessage {
  const lines = linesOf(raw);
  const compact = compactJsonFinal(lines.join('\n'));
  if (compact) return compact;
  if (lines.length === 1 && /^K2 [TFWQ](?: |$)/.test(lines[0]!))
    fail('KAP/2 line boundaries lost', 'E_LAYOUT_LOSS');
  if (lines.at(-1) !== 'K2/END') fail('Missing K2/END', 'E_TERMINATOR');
  const match = /^K2 ([TFWQ])(?: ([A-Za-z0-9_.:-]{1,64}))?$/.exec(lines[0] ?? '');
  if (!match || (match[1] === 'T') !== (match[2] !== undefined)) fail('Invalid K2 header', 'E_HEADER', 1);
  const action = match[1]!, tool = match[2] ?? null, body = lines.slice(1, -1);
  let summary = '', offset = 1;
  if (body[0]?.startsWith('@summary:')) {
    structure(body[0], 2);
    if (!body[0].startsWith('@summary: ') || body[0].length - 10 > 400) fail('Invalid summary', 'E_SCALAR', 2);
    summary = body.shift()!.slice(10);
    offset = 2;
  }
  if ((action === 'W' || action === 'Q') && body.length) fail('W/Q cannot have body', 'E_BODY_NOT_ALLOWED', offset + 1);
  let cursor = 0;
  function parse(indent: number, depth: number, schema?: Schema): Record<string, unknown> {
    if (depth > MAX_DEPTH) fail('Depth exceeded', 'E_DEPTH', offset + cursor + 1);
    const obj: Record<string, unknown> = Object.create(null);
    while (cursor < body.length) {
      const rawLine = body[cursor]!, n = offset + cursor + 1;
      structure(rawLine, n);
      const pad = rawLine.length - rawLine.trimStart().length;
      if (pad < indent) break;
      if (pad !== indent) fail('Invalid indent', 'E_INDENT', n);
      const field = FIELD.exec(rawLine.slice(indent)), literal = LITERAL.exec(rawLine.slice(indent));
      if (!field && !literal) fail('Invalid field', 'E_FIELD', n);
      const name = key((field ?? literal)![1]!, n);
      if (Object.hasOwn(obj, name)) fail('Duplicate field', 'E_KEY_DUPLICATE', n);
      cursor++;
      const target = child(schema, name);
      if (literal) {
        const marker = literal[2]!, sizeText = literal[3], start = cursor;
        if (sizeText === undefined) {
          while (cursor < body.length && body[cursor] !== marker) cursor++;
          if (cursor === body.length) fail('Unterminated literal', 'E_LITERAL_UNTERMINATED', n);
        } else {
          const expected = Number(sizeText);
          if (!Number.isSafeInteger(expected) || expected > MAX_SIZE) fail('Invalid literal size', 'E_LITERAL_LENGTH', n);
          while (cursor < body.length && utf8.encode(body.slice(start, cursor).join('\n')).length < expected) cursor++;
          if (cursor >= body.length || body[cursor] !== marker || utf8.encode(body.slice(start, cursor).join('\n')).length !== expected)
            fail('Literal length mismatch', 'E_LITERAL_LENGTH', n);
        }
        const value = body.slice(start, cursor).join('\n');
        safe(value, n, true);
        obj[name] = value;
        cursor++;
        continue;
      }
      const countText = field![2], columns = field![3], scalar = field![4];
      if (countText !== undefined) {
        const count = Number(countText);
        if (!Number.isSafeInteger(count) || count > MAX_ROWS) fail('Array too large', 'E_ARRAY_SIZE', n);
        if (scalar !== undefined) fail('Unexpected array scalar', 'E_FIELD', n);
        const headers = columns === undefined ? undefined : csv(columns, n).map(c => key(c.quoted ? JSON.stringify(c.value) : c.value, n));
        if (headers && new Set(headers).size !== headers.length) fail('Duplicate headers', 'E_TABLE_HEADERS', n);
        const rows: unknown[] = [], rowSchema = child(target);
        for (let j = 0; j < count; j++) {
          if (cursor >= body.length) fail('Missing array rows', 'E_ARRAY_ROWS', n);
          const row = body[cursor]!, rn = offset + cursor + 1;
          structure(row, rn);
          if (row.length - row.trimStart().length !== indent + 2) fail('Wrong row indent', 'E_ARRAY_ROWS', rn);
          const data = row.slice(indent + 2);
          cursor++;
          if (headers) {
            const cells = csv(data, rn);
            if (cells.length !== headers.length) fail('Wrong table columns', 'E_TABLE_COLUMNS', rn);
            const item: Record<string, unknown> = Object.create(null);
            headers.forEach((h, k) => { item[h] = atom(cells[k]!.value, rn, child(rowSchema, h), cells[k]!.quoted); });
            rows.push(item);
          } else if (data === '-') {
            const nested = parse(indent + 4, depth + 2, rowSchema);
            if (!Object.keys(nested).length) fail('Empty list object', 'E_FIELD', rn);
            rows.push(nested);
          } else if (data.startsWith('- ')) rows.push(atom(data.slice(2), rn, rowSchema));
          else fail('Invalid list row', 'E_ARRAY_ROWS', rn);
        }
        obj[name] = rows;
      } else if (scalar === '{}') obj[name] = Object.create(null);
      else if (scalar !== undefined) obj[name] = atom(scalar, n, target);
      else if (body[cursor]?.startsWith(' '.repeat(indent + 2))) {
        const nested = parse(indent + 2, depth + 1, target);
        if (!Object.keys(nested).length) fail('Empty object', 'E_FIELD', n);
        obj[name] = nested;
      } else fail('Missing field value', 'E_FIELD', n);
    }
    return obj;
  }
  if (action === 'F' && !body.length) fail('Empty final', 'E_FIELD');
  let content: string | Record<string, unknown> | null = null;
  if (action === 'W' || action === 'Q') content = null;
  else if (body.length && (FIELD.test(body[0]!) || LITERAL.test(body[0]!))) {
    content = parse(0, 0, options.schema);
    if (cursor !== body.length) fail('Incomplete object', 'E_INDENT', offset + cursor + 1);
  } else {
    if (action === 'T') fail('Tools require fields', 'E_FIELD', offset + 1);
    for (let i = 0; i < body.length; i++) {
      const line = body[i]!;
      structure(line, offset + i + 1);
      if (line === 'K2/END' || /^K2 [TFWQ](?: |$)/.test(line)) fail('Competing action', 'E_COMPETING_FRAME', offset + i + 1);
    }
    content = body.join('\n');
  }
  if (action === 'F' && (!content || (typeof content === 'string' && !content.trim()))) fail('Empty final', 'E_FIELD');
  return {action: action === 'T' ? 'use_tool' : action === 'F' ? 'final_response' : action === 'W' ? 'request_workspace' : 'request_tools',
    tool, tool_input: action === 'T' ? content as Record<string, unknown> : null,
    content: action === 'F' ? content : null, reasoning_summary: summary, loop: null};
}
function scalar(value: unknown): string {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value) || Object.is(value, -0))
      fail('Invalid number', 'E_NUMBER_RANGE');
    const text = String(value);
    if (text.includes('e')) fail('Exponent is not a KAP/2 scalar', 'E_SCALAR');
    return text;
  }
  if (typeof value !== 'string') fail('Unsupported scalar', 'E_SCALAR');
  safe(value);
  if (value.includes('\n') || value.includes('\r')) fail('Multiline requires literal', 'E_SCALAR');
  if (value === '' || value !== value.trim() || value.startsWith('"') || ['true','false','null'].includes(value) ||
      INTEGER.test(value) || DECIMAL.test(value) || value.startsWith('-0') || value.includes('"'))
    return JSON.stringify(value);
  return value;
}
export function encodeKAP2(value: Record<string, unknown>): string {
  if (!record(value) || !Object.keys(value).length) fail('Empty final object', 'E_FIELD');
  const lines = ['K2 F'];
  function name(v: string): string {
    safe(v); if (DENIED.has(v)) fail('Unsafe key', 'E_KEY_UNSAFE');
    return KEY.test(v) ? v : JSON.stringify(v);
  }
  function write(value: Record<string, unknown>, indent: number): void {
    if (indent / 2 > MAX_DEPTH) fail('Depth limit', 'E_DEPTH');
    for (const [k, v] of Object.entries(value)) {
      const prefix = ' '.repeat(indent) + name(k);
      if (record(v)) {
        if (Object.keys(v).length) { lines.push(prefix + ':'); write(v, indent + 2); }
        else lines.push(prefix + ': {}');
      } else if (Array.isArray(v)) {
        if (v.length > MAX_ROWS) fail('Array limit', 'E_ARRAY_SIZE');
        lines.push(prefix + '[' + v.length + ']:');
        for (const item of v) {
          if (record(item)) {
            if (!Object.keys(item).length) fail('Empty object item', 'E_FIELD');
            lines.push(' '.repeat(indent + 2) + '-');
            write(item, indent + 4);
          } else lines.push(' '.repeat(indent + 2) + '- ' + scalar(item));
        }
      } else if (typeof v === 'string' && v.includes('\n')) {
        let marker = 'CODE';
        if (v.split('\n').includes(marker)) marker = 'KAP_LITERAL';
        if (v.split('\n').includes(marker)) fail('Literal marker collision', 'E_LITERAL_LENGTH');
        lines.push(prefix + '<<' + marker, ...v.split('\n'), marker);
      } else lines.push(prefix + ': ' + scalar(v));
    }
  }
  write(value, 0);
  lines.push('K2/END');
  const result = lines.join('\n');
  if (utf8.encode(result).length > MAX_SIZE || lines.length > MAX_LINES) fail('Encoded frame too large', 'E_SIZE');
  return result;
}

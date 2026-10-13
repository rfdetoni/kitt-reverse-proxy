/** KAP/2: deterministic compact model syntax. Host still owns authorization. */
import type { KAPMessage } from './kap.js';

const FIELD = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[([0-9]+)\](?:\{([A-Za-z0-9_,]+)\})?)?:(?: (.*))?$/;
const LITERAL = /^([A-Za-z_][A-Za-z0-9_]*)<<([A-Z_][A-Z0-9_]{0,24})$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_SIZE = 65536;
const MAX_LINES = 3000;
const MAX_DEPTH = 20;
const MAX_ROWS = 1024;

function atom(input: string): unknown {
  if (input.startsWith('"')) {
    let value: unknown;
    try { value = JSON.parse(input); } catch { throw new Error('Invalid quoted scalar'); }
    if (typeof value !== 'string') throw new Error('Quoted scalar must be a string');
    return value;
  }
  if (input === 'true') return true;
  if (input === 'false') return false;
  if (input === 'null') return null;
  if (/^-?(0|[1-9][0-9]*)$/.test(input)) {
    const value = Number(input);
    if (!Number.isSafeInteger(value)) throw new Error('Unsafe KAP/2 integer');
    return value;
  }
  if (/^-?(0|[1-9][0-9]*)\.[0-9]+$/.test(input)) {
    const value = Number(input);
    if (!Number.isFinite(value)) throw new Error('Invalid KAP/2 decimal');
    return value;
  }
  return input;
}

function csv(line: string): string[] {
  const cells: string[] = [];
  let index = 0;
  while (index <= line.length) {
    const start = index;
    if (line[index] === '"') {
      index++;
      let quoted = '';
      let closed = false;
      while (index < line.length) {
        if (line[index] === '"') {
          if (line[index + 1] === '"') { quoted += '"'; index += 2; }
          else { index++; closed = true; break; }
        } else { quoted += line[index++]; }
      }
      if (!closed || (index < line.length && line[index] !== ',')) throw new Error('Invalid quoted table cell');
      cells.push(JSON.stringify(quoted));
    } else {
      while (index < line.length && line[index] !== ',') {
        if (line[index] === '"') throw new Error('Unexpected CSV quote');
        index++;
      }
      cells.push(line.slice(start, index).trim());
    }
    if (index === line.length) break;
    index++;
  }
  return cells;
}

function parseFields(lines: string[]): Record<string, unknown> {
  let index = 0;
  function read(indent: number, depth: number): Record<string, unknown> {
    if (depth > MAX_DEPTH) throw new Error('KAP/2 nesting limit exceeded');
    const object: Record<string, unknown> = Object.create(null);
    while (index < lines.length) {
      const raw = lines[index]!;
      if (raw.includes('\t')) throw new Error('KAP/2 tabs are forbidden');
      const leading = raw.length - raw.trimStart().length;
      if (leading < indent) break;
      if (leading !== indent) throw new Error('Invalid KAP/2 indentation');
      const line = raw.slice(indent);
      const field = FIELD.exec(line);
      const literal = LITERAL.exec(line);
      if (!field && !literal) throw new Error('Invalid KAP/2 field');
      const key = (field ?? literal)![1]!;
      if (!KEY.test(key) || FORBIDDEN.has(key) || Object.hasOwn(object, key)) throw new Error('Duplicate or unsafe field');
      index++;
      if (literal) {
        const marker = literal[2]!;
        const start = index;
        while (index < lines.length && lines[index] !== marker) index++;
        if (index === lines.length) throw new Error('Unterminated KAP/2 literal');
        object[key] = lines.slice(start, index).join('\n');
        index++;
        continue;
      }
      const countValue = field![2];
      const columns = field![3];
      const scalar = field![4];
      if (countValue !== undefined) {
        const count = Number(countValue);
        if (!Number.isInteger(count) || count > MAX_ROWS) throw new Error('KAP/2 array too large');
        if (scalar !== undefined) throw new Error('Unexpected array scalar');
        const headers = columns?.split(',');
        if (headers && (new Set(headers).size !== headers.length || headers.some(h => !KEY.test(h) || FORBIDDEN.has(h)))) {
          throw new Error('Invalid table headers');
        }
        const rows: unknown[] = [];
        for (let n = 0; n < count; n++) {
          const row = lines[index];
          if (row === undefined || !row.startsWith(' '.repeat(indent + 2)) || row.startsWith(' '.repeat(indent + 3))) {
            throw new Error('Wrong KAP/2 row count or indentation');
          }
          index++;
          const content = row.slice(indent + 2);
          if (headers) {
            const cells = csv(content);
            if (cells.length !== headers.length) throw new Error('Wrong table column count');
            const record: Record<string, unknown> = Object.create(null);
            headers.forEach((name, i) => { record[name] = atom(cells[i]!); });
            rows.push(record);
          } else {
            if (!content.startsWith('- ')) throw new Error('Expected list item');
            rows.push(atom(content.slice(2)));
          }
        }
        object[key] = rows;
      } else if (scalar !== undefined) {
        object[key] = atom(scalar);
      } else if (lines[index]?.startsWith(' '.repeat(indent + 2))) {
        object[key] = read(indent + 2, depth + 1);
      } else {
        object[key] = Object.create(null);
      }
    }
    return object;
  }
  const result = read(0, 0);
  if (index !== lines.length) throw new Error('Incomplete KAP/2 object');
  return result;
}

/** One complete envelope only; does not execute tools or repair invalid payloads. */
export function parseKAP2(raw: string): KAPMessage {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_SIZE) throw new Error('KAP/2 exceeds 64 KiB');
  const lines = raw.trim().split(/\r?\n/);
  if (lines.length > MAX_LINES || lines.at(-1) !== 'K2/END') throw new Error('Missing K2/END');
  const header = /^K2 ([TFWQ])(?: ([A-Za-z0-9_.:-]{1,64}))?$/.exec(lines[0] ?? '');
  if (!header) throw new Error('Invalid K2 header');
  const kind = header[1]!;
  const tool = header[2] ?? null;
  if ((kind === 'T') !== (tool !== null)) throw new Error('Invalid K2 tool declaration');
  const body = lines.slice(1, -1);
  if (kind !== 'T' && body.length === 0) {
    if (kind === 'F') throw new Error('Empty K2 final');
    return { action: kind === 'W' ? 'request_workspace' : 'request_tools', tool: null, tool_input: null, content: null, reasoning_summary: '', loop: null };
  }
  if (body.some(line => /^K2 (?:[TFWQ])(?: |$)|^K2\/END$/.test(line))) throw new Error('Competing K2 envelope');
  const structured = body.length > 0 && (FIELD.test(body[0]!) || LITERAL.test(body[0]!));
  if (kind === 'T' && !structured && body.length) throw new Error('Tools require KAP/2 fields');
  const data = structured ? parseFields(body) : null;
  if (kind === 'T') {
    return { action: 'use_tool', tool, tool_input: data ?? Object.create(null), content: null, reasoning_summary: '', loop: null };
  }
  const content = data ?? body.join('\n');
  if (kind === 'F' && (typeof content === 'string' ? !content.trim() : Object.keys(content).length === 0)) throw new Error('Empty K2 final');
  return { action: kind === 'F' ? 'final_response' : kind === 'W' ? 'request_workspace' : 'request_tools', tool: null, tool_input: null, content, reasoning_summary: '', loop: null };
}

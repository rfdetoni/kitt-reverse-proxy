import type { JsonValue } from '../types.js';

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

type Segment = string | number | '*';

export function parseJsonPath(path: string): Segment[] {
  if (!path.startsWith('$')) throw new Error(`JSON path deve começar com $: ${path}`);
  const segments: Segment[] = [];
  let i = 1;
  while (i < path.length) {
    if (path[i] === '.') {
      i += 1;
      const start = i;
      while (i < path.length && /[A-Za-z0-9_$-]/.test(path[i]!)) i += 1;
      if (start === i) throw new Error(`Segmento inválido em ${path}`);
      const key = path.slice(start, i);
      if (FORBIDDEN_SEGMENTS.has(key)) throw new Error(`Segmento proibido em JSON path: ${key}`);
      segments.push(key);
      continue;
    }
    if (path[i] === '[') {
      const end = path.indexOf(']', i);
      if (end < 0) throw new Error(`Colchete não fechado em ${path}`);
      const token = path.slice(i + 1, end).trim();
      if (token === '*') segments.push('*');
      else if (/^\d+$/.test(token)) segments.push(Number(token));
      else throw new Error(`Índice inválido em ${path}`);
      i = end + 1;
      continue;
    }
    throw new Error(`JSON path inválido: ${path}`);
  }
  return segments;
}

export function getPathValues(root: JsonValue, path: string): JsonValue[] {
  const segments = parseJsonPath(path);
  let current: JsonValue[] = [root];
  for (const segment of segments) {
    const next: JsonValue[] = [];
    for (const value of current) {
      if (segment === '*') {
        if (Array.isArray(value)) next.push(...value);
        continue;
      }
      if (typeof segment === 'number') {
        if (Array.isArray(value) && segment < value.length) next.push(value[segment]!);
        continue;
      }
      if (value && typeof value === 'object' && !Array.isArray(value) && segment in value) {
        next.push(value[segment]!);
      }
    }
    current = next;
  }
  return current;
}

export function setJsonPath(root: JsonValue, path: string, value: JsonValue): void {
  const segments = parseJsonPath(path);
  if (segments.length === 0) throw new Error('Não é permitido substituir a raiz inteira via binding.');
  if (segments.includes('*')) throw new Error(`Wildcard não permitido em target path: ${path}`);

  let cursor: JsonValue = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    const nextSegment = segments[index + 1]!;
    if (typeof segment === 'number') {
      if (!Array.isArray(cursor)) throw new Error(`Esperado array em ${path}`);
      while (cursor.length <= segment) cursor.push(null);
      let child = cursor[segment];
      if (!child || typeof child !== 'object') {
        child = typeof nextSegment === 'number' ? [] : {};
        cursor[segment] = child;
      }
      cursor = child;
    } else {
      if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) throw new Error(`Esperado objeto em ${path}`);
      let child = cursor[segment];
      if (!child || typeof child !== 'object') {
        child = typeof nextSegment === 'number' ? [] : {};
        cursor[segment] = child;
      }
      cursor = child;
    }
  }

  const last = segments.at(-1)!;
  if (typeof last === 'number') {
    if (!Array.isArray(cursor)) throw new Error(`Esperado array em ${path}`);
    while (cursor.length <= last) cursor.push(null);
    cursor[last] = value;
  } else {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) throw new Error(`Esperado objeto em ${path}`);
    cursor[last] = value;
  }
}

export function deleteJsonPath(root: JsonValue, path: string): void {
  const segments = parseJsonPath(path);
  if (segments.length === 0 || segments.includes('*')) return;
  let cursor: JsonValue = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    if (typeof segment === 'number') {
      if (!Array.isArray(cursor) || !cursor[segment]) return;
      cursor = cursor[segment]!;
    } else {
      if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || !(segment in cursor)) return;
      cursor = cursor[segment]!;
    }
  }
  const last = segments.at(-1)!;
  if (typeof last === 'number') {
    if (Array.isArray(cursor) && last < cursor.length) cursor.splice(last, 1);
  } else if (cursor && typeof cursor === 'object' && !Array.isArray(cursor)) {
    delete cursor[last];
  }
}

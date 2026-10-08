import { parseContractJson } from '../src/util/contract-json.js';

type JsonLike = null | string | number | boolean | JsonLike[] | { [key: string]: JsonLike };
function field(lines: string[], path: string, value: JsonLike): void {
  if (value === null) lines.push('NULL ' + path);
  else if (Array.isArray(value)) {
    lines.push('ARRAY ' + path);
    value.forEach((item, i) => field(lines, path + '.' + i, item));
  } else if (typeof value === 'object') {
    lines.push('OBJECT ' + path);
    Object.entries(value).forEach(([name, item]) => field(lines, path + '.' + name, item));
  } else if (typeof value === 'string' && value.includes('\n')) {
    lines.push('TEXT ' + path, value, 'KITT/ENDTEXT');
  } else if (typeof value === 'string') lines.push('STRING ' + path + ' = ' + value);
  else if (typeof value === 'boolean') lines.push('BOOLEAN ' + path + ' = ' + value);
  else lines.push((Number.isInteger(value) ? 'INTEGER ' : 'DECIMAL ') + path + ' = ' + value);
}

/** Encode historical typed fixtures as WebChat KAP/1, not JSON emitted by the LLM. */
export function kapFixture(value: Record<string, any>): string {
  const actions: Record<string, string> = { use_tool:'TOOL', final_response:'FINAL', request_workspace:'WORKSPACE', request_tools:'TOOLS' };
  const action = actions[String(value.action)];
  if (!action) throw new Error('Invalid fixture action');
  const lines = ['KITT/1', 'ACTION ' + action];
  if (action === 'TOOL') {
    if (typeof value.tool === 'string') lines.push('TOOL ' + value.tool);
    if (value.tool_input && typeof value.tool_input === 'object') {
      Object.entries(value.tool_input).forEach(([name, item]) => field(lines, name, item as JsonLike));
    }
  } else if (value.content !== undefined && value.content !== null) {
    field(lines, 'content', value.content as JsonLike);
  }
  if (value.reasoning_summary) lines.push('SUMMARY ' + value.reasoning_summary);
  lines.push('KITT/END');
  return lines.join('\n');
}

export function kapFromHistoricFixture(raw: string): string {
  // Only complete unambiguous typed fixtures may be transformed. Intentionally
  // malformed model output remains malformed; no production JSON fallback.
  try {
    const candidate = parseContractJson(raw).value as Record<string, any>;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return raw;
    if (Object.keys(candidate).sort().join(',') !== 'action,content,loop,reasoning_summary,tool,tool_input') return raw;
    if (candidate.loop !== null || typeof candidate.action !== 'string' || typeof candidate.reasoning_summary !== 'string') return raw;
    if (candidate.action === 'use_tool' && (typeof candidate.tool !== 'string' || typeof candidate.tool_input !== 'object')) return raw;
    if (candidate.action !== 'use_tool' && (candidate.tool !== null || candidate.tool_input !== null)) return raw;
    return kapFixture(candidate);
  } catch { return raw; }
}

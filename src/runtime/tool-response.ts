import {
  assertToolChoiceSatisfied,
  extractToolCalls,
  toolCallEnvelopes,
  ToolProtocolError,
  type OpenAiToolCall,
  type ParsedModelOutput,
  type ToolProtocolPlan
} from '../mapping/tool-calling.js';
import { validateJsonSchema } from '../util/json-schema.js';
import { telemetry } from '../util/telemetry.js';

export interface UiArtifactLike {
  code: string;
  filename?: string | undefined;
  language?: string | undefined;
}

export class ToolParseFailedError extends ToolProtocolError {
  constructor(message: string) {
    super(message, 'model');
    this.name = 'ToolParseFailedError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeArtifactPath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function selectArtifact(path: string, artifacts: readonly UiArtifactLike[]): UiArtifactLike | undefined {
  const usable = artifacts.filter((artifact) => typeof artifact.code === 'string' && artifact.code.length > 0);
  if (!usable.length) return undefined;
  const target = normalizeArtifactPath(path);
  const targetBase = target.split('/').at(-1) ?? target;
  const matches = usable.filter((artifact) => {
    if (!artifact.filename) return false;
    const candidate = normalizeArtifactPath(artifact.filename);
    const candidateBase = candidate.split('/').at(-1) ?? candidate;
    return candidate === target || candidate.endsWith(`/${target}`) || candidateBase === targetBase;
  });
  if (matches.length === 1) return matches[0];
  return usable.length === 1 ? usable[0] : undefined;
}

function hydrateArtifactBackedWrites(calls: readonly OpenAiToolCall[], artifacts: readonly UiArtifactLike[]): void {
  if (!artifacts.length) return;
  for (const call of calls) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.function.arguments);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;

    let writeArgs: Record<string, unknown> | undefined;
    if (['write_file', 'repo.write_file'].includes(call.function.name)) {
      writeArgs = parsed;
    } else if (call.function.name === 'kitt_runtime' && parsed.operation === 'repo.write_file' && isRecord(parsed.arguments)) {
      writeArgs = parsed.arguments;
    }
    if (!writeArgs || typeof writeArgs.path !== 'string') continue;
    if (typeof writeArgs.content === 'string' && writeArgs.content.length > 0) continue;

    const artifact = selectArtifact(writeArgs.path, artifacts);
    if (!artifact) continue;
    writeArgs.content = artifact.code;
    call.function.arguments = JSON.stringify(parsed);
  }
}

function validateArguments(calls: readonly OpenAiToolCall[], plan: ToolProtocolPlan): void {
  for (const call of calls) {
    const tool = plan.tools.find((candidate) => candidate.name === call.function.name);
    if (!tool) throw new ToolParseFailedError(`Function fora da allowlist: ${call.function.name}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.function.arguments);
    } catch {
      throw new ToolParseFailedError(`Arguments de ${call.function.name} não são JSON válido.`);
    }
    const result = validateJsonSchema(parsed, tool.parameters);
    if (!result.valid) {
      const summary = result.issues.slice(0, 6).map((entry) => `${entry.path}: ${entry.message}`).join('; ');
      throw new ToolParseFailedError(`Arguments de ${call.function.name} violam o JSON Schema: ${summary}`);
    }
  }
}

function toolish(text: string): boolean {
  return /<tool_call\b|<\/tool_call>|```(?:tool[_-]?call|function[_-]?call)|\b(?:tool|function)[ _-]?call\s*[:=]/i.test(text);
}

function maskOrdinaryCodeFences(text: string): string {
  return text.replace(
    /```(?!\s*(?:tool[_-]?call|function[_-]?call)\b)[^\n\r]*[\r\n][\s\S]*?```/gi,
    (block) => ' '.repeat(block.length)
  );
}

function isEscapedQuote(input: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && input[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function escapeRawContentQuotes(input: string): string | undefined {
  const match = /"content"\s*:\s*"/g.exec(input);
  if (!match) return undefined;
  const contentStart = match.index + match[0].length;
  const candidates: number[] = [];
  for (let index = contentStart; index < input.length; index += 1) {
    if (input[index] === '"' && !isEscapedQuote(input, index)) candidates.push(index);
  }

  for (const closing of candidates.slice(-128).reverse()) {
    let body = '';
    for (let index = contentStart; index < closing; index += 1) {
      const current = input[index]!;
      if (current === '"' && !isEscapedQuote(input, index)) body += '\\"';
      else if (current === '\n') body += '\\n';
      else if (current === '\r') body += '\\r';
      else if (current === '\t') body += '\\t';
      else body += current;
    }
    const candidate = `${input.slice(0, contentStart)}${body}${input.slice(closing)}`;
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Try the next possible closing delimiter.
    }
  }
  return undefined;
}

function repairJsonStringEscapes(input: string): string {
  let output = '';
  let inString = false;

  for (let index = 0; index < input.length; index += 1) {
    const current = input[index]!;
    if (!inString) {
      output += current;
      if (current === '"') inString = true;
      continue;
    }

    if (current === '"') {
      const next = input.slice(index + 1).match(/\S/u)?.[0];
      if (next !== undefined && !':,}]'.includes(next)) {
        output += '\\"';
        continue;
      }
      output += current;
      inString = false;
      continue;
    }

    if (current === '\\') {
      const next = input[index + 1];
      if (next === undefined) {
        output += '\\\\';
        continue;
      }
      if ('"\\/bfnrt'.includes(next)) {
        output += current + next;
        index += 1;
        continue;
      }
      if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(input.slice(index + 2, index + 6))) {
        output += input.slice(index, index + 6);
        index += 5;
        continue;
      }
      output += '\\\\';
      continue;
    }

    const code = current.charCodeAt(0);
    if (code < 0x20) {
      if (current === '\n') output += '\\n';
      else if (current === '\r') output += '\\r';
      else if (current === '\t') output += '\\t';
      else output += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }

    output += current;
  }

  return output;
}

function normalizeToolEnvelopeBody(input: string): string {
  const trimmed = input.trim();
  try { JSON.parse(trimmed); return trimmed; } catch { /* Repair only invalid transport JSON. */ }
  const candidates = [trimmed];
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  const quoteLike = (value: string | undefined): value is string => value === "'" || value === '`';

  if (quoteLike(first) && trimmed.length > 1) candidates.push(trimmed.slice(1).trimStart());
  if (quoteLike(last) && trimmed.length > 1) candidates.push(trimmed.slice(0, -1).trimEnd());
  if (quoteLike(first) && first === last && trimmed.length > 2) {
    candidates.push(trimmed.slice(1, -1).trim());
  }

  for (const candidate of [...new Set(candidates)]) {
    const contentRepaired = escapeRawContentQuotes(candidate);
    if (contentRepaired) return contentRepaired;

    const repaired = repairJsonStringEscapes(candidate);
    try {
      JSON.parse(repaired);
      return repaired;
    } catch {
      // Only discard provider presentation quotes when the resulting payload
      // is independently valid JSON. Structural corruption still fails closed.
    }
  }

  const queue = [trimmed];
  const seen = new Set(queue);
  for (let attempts = 0; queue.length && attempts < 128; attempts += 1) {
    const candidate = queue.shift()!;
    const repaired = repairJsonStringEscapes(candidate);
    try {
      JSON.parse(repaired);
      return repaired;
    } catch {
      for (let index = 0; index < candidate.length; index += 1) {
        if (candidate[index] !== '"' || candidate[index - 1] === '\\') continue;
        const next = candidate.slice(index + 1).match(/\S/u)?.[0];
        if (next === undefined || !':,}]'.includes(next)) continue;
        const variant = `${candidate.slice(0, index)}\\"${candidate.slice(index + 1)}`;
        if (!seen.has(variant)) {
          seen.add(variant);
          queue.push(variant);
        }
      }
    }
  }

  return repairJsonStringEscapes(trimmed);
}

function normalizeProviderPatterns(text: string): string {
  const canonical = toolCallEnvelopes(maskOrdinaryCodeFences(text));
  if (canonical.length) {
    try { canonical.forEach(block => JSON.parse(block.body)); return text; } catch { /* Repair invalid JSON below. */ }
  }

  let normalized = text.replace(
    /```(?:tool[_-]?call|function[_-]?call)\s*\r?\n?([\s\S]*?)```/gi,
    (_whole, rawBody: string) => `<tool_call>${normalizeToolEnvelopeBody(rawBody)}</tool_call>`
  );

  normalized = normalized.replace(
    /<tool_call\s+name=["']([A-Za-z0-9_.:-]{1,64})["']\s*>([\s\S]*?)<\/tool_call>/gi,
    (_whole, rawName: string, rawBody: string) => {
      const body = rawBody.trim();
      let args: unknown = {};
      try {
        args = body ? JSON.parse(normalizeToolEnvelopeBody(body)) : {};
      } catch {
        args = { value: body };
      }
      const record = isRecord(args) && Object.prototype.hasOwnProperty.call(args, 'arguments')
        ? args
        : { arguments: args };
      return `<tool_call>${JSON.stringify({ name: rawName, ...record })}</tool_call>`;
    }
  );

  normalized = normalized.replace(
    /\b(?:tool|function)[ _-]?call\s*[:=]\s*(\{[\s\S]*?\})(?=\s*(?:$|\n))/gi,
    (_whole, payload: string) => `<tool_call>${payload}</tool_call>`
  );

  for (const block of toolCallEnvelopes(maskOrdinaryCodeFences(normalized))) {
    normalized = normalized.replace(block.whole, () => `<tool_call>${normalizeToolEnvelopeBody(block.body)}</tool_call>`);
  }

  return normalized;
}

export function parseUiToolResponse(
  text: string,
  plan: ToolProtocolPlan,
  artifacts: readonly UiArtifactLike[] = [],
  provider = 'unknown'
): ParsedModelOutput {
  if (!plan.tools.length || plan.choice.mode === 'none') return { content: text };
  const normalized = normalizeProviderPatterns(text);
  const protocolVisibleText = maskOrdinaryCodeFences(normalized);
  const explicitEnvelopes = toolCallEnvelopes(protocolVisibleText);
  let parsed: ParsedModelOutput = { content: text };

  if (explicitEnvelopes.length) {
    try {
      parsed = extractToolCalls(normalized, plan);
    } catch (error) {
      telemetry.recordParseFailure(/<tool_call\b/iu.test(normalized) ? 'regex' : 'json');
      throw error;
    }
  }

  if (parsed.tool_calls?.length) {
    hydrateArtifactBackedWrites(parsed.tool_calls, artifacts);
    validateArguments(parsed.tool_calls, plan);
    assertToolChoiceSatisfied(plan, parsed.tool_calls);
    for (const call of parsed.tool_calls) telemetry.recordToolCall(provider, call.function.name, 'success');
    return parsed;
  }

  if (toolish(protocolVisibleText)) {
    telemetry.recordParseFailure('rejected');
    throw new ToolParseFailedError('A resposta parece conter uma tool call explícita, mas nenhum formato válido pôde ser extraído.');
  }

  assertToolChoiceSatisfied(plan, parsed.tool_calls);
  return parsed;
}

export function buildToolRetryPrompt(plan: ToolProtocolPlan, reason: string): string {
  const exposed = plan.tools.map((tool) => ({
    name: tool.name,
    parameters: tool.parameters ?? { type: 'object' }
  }));
  const example = '<tool_call>{"name":"ALLOWED_TOOL_NAME","arguments":{}}</tool_call>';
  return [
    'Your previous response could not be parsed as a valid tool call.',
    `Reason: ${reason.slice(0, 600)}`,
    `Allowed tools and schemas: ${JSON.stringify(exposed)}`,
    'Use the same canonical tool-call protocol as the original request; do not switch to bare JSON.',
    `Respond ONLY with one or more canonical blocks shaped exactly like: ${example}`,
    'Replace ALLOWED_TOOL_NAME with an allowed name and populate arguments to match that tool schema.',
    'For file contents, emit valid JSON escaping for quotes, backslashes and newlines; prefer one small mutation per call rather than several large writes in one response.',
    'If the UI already emitted the complete file as a code artifact, a write call may contain only its path; KITT will attach the single matching artifact before schema validation.',
    'Ordinary JSON/code blocks are treated as data, never as tool calls. Do not place a requested tool call inside a markdown code block.',
    'Do not use markdown or explanatory text. Hidden website tool calls are not forwarded.',
    'Stop after the tool-call block(s) and wait for the external agent to return the result.'
  ].join('\n');
}

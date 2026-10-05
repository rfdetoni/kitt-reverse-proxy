import { parseContractJson } from '../util/contract-json.js';
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
    return candidate === target || (!candidate.includes('/') && candidateBase === targetBase);
  });
  if (matches.length === 1) return matches[0];
  return undefined;
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
    if (Object.hasOwn(writeArgs, 'content')) continue;

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

function normalizeToolEnvelopeBody(input: string): string {
  const trimmed = input.trim();
  // Presentation quotes must surround a complete object, never internal data.
  const wrapped = trimmed.match(/^(['`])([\s\S]+)\1$/u);
  const trailing = trimmed.match(/^(\{[\s\S]*\})['`]$/u);
  return parseContractJson(wrapped?.[2] ?? trailing?.[1] ?? trimmed).text;
}

function normalizeProviderPatterns(text: string): string {
  const canonical = toolCallEnvelopes(maskOrdinaryCodeFences(text));
  if (canonical.length) {
    try { if (canonical.every(block => !parseContractJson(block.body).repaired)) return text; } catch { /* Repair invalid JSON below. */ }
  }

  let normalized = text.replace(
    /```(?:tool[_-]?call|function[_-]?call)\s*\r?\n?([\s\S]*?)```/gi,
    (_whole, rawBody: string) => `<tool_call>${normalizeToolEnvelopeBody(rawBody)}</tool_call>`
  );

  normalized = normalized.replace(
    /<tool_call\s+name=["']([A-Za-z0-9_.:-]{1,64})["']\s*>([\s\S]*?)<\/tool_call>/gi,
    (_whole, rawName: string, rawBody: string) => {
      const body = rawBody.trim();
      const args: unknown = body ? JSON.parse(normalizeToolEnvelopeBody(body)) : {};
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
  let normalized: string;
  try { normalized = normalizeProviderPatterns(text); }
  catch (error) { throw new ToolParseFailedError(error instanceof Error ? error.message : String(error)); }
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

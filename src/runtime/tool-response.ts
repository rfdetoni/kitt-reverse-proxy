import { randomUUID } from 'node:crypto';
import type { JsonObject } from '../types.js';
import {
  assertToolChoiceSatisfied,
  extractToolCalls,
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

function normalizeProviderPatterns(text: string): string {
  let normalized = text.replace(/```(?:tool[_-]?call|function[_-]?call)\s*/gi, '```json\n');

  normalized = normalized.replace(
    /<tool_call\s+name=["']([A-Za-z0-9_.:-]{1,64})["']\s*>([\s\S]*?)<\/tool_call>/gi,
    (_whole, rawName: string, rawBody: string) => {
      const body = rawBody.trim();
      let args: unknown = {};
      try {
        args = body ? JSON.parse(body) : {};
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
  return normalized;
}

function synthesizeWriteCalls(
  text: string,
  plan: ToolProtocolPlan,
  artifacts: readonly UiArtifactLike[]
): OpenAiToolCall[] {
  if (!artifacts.length) return [];
  const writeTool = plan.tools.find((tool) =>
    ['write_file', 'write_to_file', 'create_file', 'apply_diff', 'edit_file'].includes(tool.name)
  );
  if (!writeTool) return [];

  const schema = isRecord(writeTool.parameters) ? writeTool.parameters : undefined;
  const properties = schema && isRecord(schema.properties) ? schema.properties : undefined;
  const has = (key: string): boolean => Boolean(properties && Object.prototype.hasOwnProperty.call(properties, key));

  const pathKey = has('path') ? 'path' : has('TargetFile') ? 'TargetFile' : has('target_file') ? 'target_file' : 'path';
  const contentKey = has('content') ? 'content' : has('CodeContent') ? 'CodeContent' : has('code') ? 'code' : 'content';

  const named = text.match(/(?:Baixar\/abrir|arquivo|salvar|criar)\s+([a-zA-Z0-9_.-]+\.[a-zA-Z0-9_-]{1,12})/i)
    ?? text.match(/`([a-zA-Z0-9_.-]+\.[a-zA-Z0-9_-]{1,12})`/);
  const fallbackFilename = named?.[1];

  return artifacts.map((artifact) => {
    const filename = artifact.filename || fallbackFilename || 'index.html';
    const args: JsonObject = {
      [pathKey]: filename,
      [contentKey]: artifact.code
    };
    if (has('Overwrite')) args.Overwrite = true;
    if (has('Description')) args.Description = `Create ${filename}`;
    return {
      id: `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      type: 'function',
      function: {
        name: writeTool.name,
        arguments: JSON.stringify(args)
      }
    };
  });
}

export function parseUiToolResponse(
  text: string,
  plan: ToolProtocolPlan,
  artifacts: readonly UiArtifactLike[] = [],
  provider = 'unknown'
): ParsedModelOutput {
  const normalized = normalizeProviderPatterns(text);
  let parsed: ParsedModelOutput;

  const trimmed = normalized.trim();
  try {
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      parsed = extractToolCalls(normalized, plan);
      if (!parsed.tool_calls?.length && toolish(normalized)) telemetry.recordParseFailure('json');
    } else {
      parsed = extractToolCalls(normalized, plan);
    }
  } catch (error) {
    telemetry.recordParseFailure(/```/u.test(normalized) ? 'codeblock' : /<tool_call\b/iu.test(normalized) ? 'regex' : 'json');
    throw error;
  }

  if (!parsed.tool_calls?.length && artifacts.length) {
    const synthesized = synthesizeWriteCalls(text, plan, artifacts);
    if (synthesized.length) {
      parsed.tool_calls = synthesized;
      parsed.content = text.replace(/Baixar\/abrir[^\n]*/gi, '').trim() || null;
    }
  }

  if (parsed.tool_calls?.length) {
    validateArguments(parsed.tool_calls, plan);
    assertToolChoiceSatisfied(plan, parsed.tool_calls);
    for (const call of parsed.tool_calls) telemetry.recordToolCall(provider, call.function.name, 'success');
    return parsed;
  }

  if (toolish(normalized)) {
    telemetry.recordParseFailure('rejected');
    throw new ToolParseFailedError('A resposta parece conter uma tool call, mas nenhum formato válido pôde ser extraído.');
  }

  assertToolChoiceSatisfied(plan, parsed.tool_calls);
  return parsed;
}

export function buildToolRetryPrompt(plan: ToolProtocolPlan, reason: string): string {
  const exposed = plan.tools.map((tool) => ({
    name: tool.name,
    parameters: tool.parameters ?? { type: 'object' }
  }));
  const payload = JSON.stringify({
    allowed_tools: exposed,
    output: {
      name: '<allowed function name>',
      arguments: '<JSON object matching that function schema>'
    }
  });
  return [
    'Your previous response could not be parsed as a valid tool call.',
    `Reason: ${reason.slice(0, 600)}`,
    `Respond ONLY with valid JSON matching: ${payload}`,
    'Do not use markdown or explanatory text.'
  ].join('\n');
}

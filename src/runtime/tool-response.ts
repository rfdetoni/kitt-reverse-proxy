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

      // Preserve source-code escapes such as Python's \x00 or regex \d by
      // escaping only the JSON transport backslash. JSON.parse then yields
      // the exact original source text instead of rejecting the whole call.
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

function normalizeProviderPatterns(text: string): string {
  let normalized = text.replace(/```(?:tool[_-]?call|function[_-]?call)\s*/gi, '```json\n');

  normalized = normalized.replace(
    /<tool_call\s+name=["']([A-Za-z0-9_.:-]{1,64})["']\s*>([\s\S]*?)<\/tool_call>/gi,
    (_whole, rawName: string, rawBody: string) => {
      const body = rawBody.trim();
      let args: unknown = {};
      try {
        args = body ? JSON.parse(repairJsonStringEscapes(body)) : {};
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

  // Browser models often embed source code directly in textual JSON tool
  // envelopes. Repair only invalid JSON string escapes/control characters;
  // structural JSON errors still fail closed in extractToolCalls().
  normalized = normalized.replace(
    /<tool_call>([\s\S]*?)<\/tool_call>/gi,
    (_whole, body: string) => `<tool_call>${repairJsonStringEscapes(body)}</tool_call>`
  );

  return normalized;
}

export function parseUiToolResponse(
  text: string,
  plan: ToolProtocolPlan,
  _artifacts: readonly UiArtifactLike[] = [],
  provider = 'unknown'
): ParsedModelOutput {
  if (!plan.tools.length || plan.choice.mode === 'none') return { content: text };
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
    'Print the JSON in the visible assistant reply. Hidden website tool calls are not forwarded.',
    'Do not use markdown or explanatory text. Stop and wait for the external agent to return the result.'
  ].join('\n');
}

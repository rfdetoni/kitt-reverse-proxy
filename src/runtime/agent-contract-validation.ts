/** Canonical validation for agent actions; no browser or session state. */
import { ContractJsonError, parseContractJson } from '../util/contract-json.js';
import { AGENT_RESPONSE_SCHEMA } from '../contracts/agent-contract.js';
import { MAX_TOOL_ARGUMENT_BYTES } from '../contracts/provider-limits.js';
import { validateJsonSchema } from '../util/json-schema.js';
import type { AgentContractPlan, AgentContractResponse } from './agent-contract.js';

const INVALID_CONTRACT_MESSAGE = 'The model response is not a valid JSON action.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export type AgentRecoveryAction = 'continue' | 'retry';

export class AgentContractError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly recoverable = false,
    public readonly recoveryAction: AgentRecoveryAction | null = null
  ) {
    super(message);
    this.name = 'AgentContractError';
  }
}

export class AgentContractValidationError extends AgentContractError {
  constructor(message: string, public readonly kind: 'syntax' | 'shape' | 'schema' | 'ambiguous' | 'limit' = 'shape', public readonly paths: string[] = []) {
    super(502, 'agent_contract_invalid', message);
    this.name = 'AgentContractValidationError';
  }
}

function sentenceCount(text: string): number {
  const normalized = text.trim();
  if (!normalized) return 0;
  return normalized.split(/(?<=[.!?])\s+/u).filter((part) => part.trim()).length;
}

export function isBareStructuredResult(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length > 0
    && !Object.keys(AGENT_RESPONSE_SCHEMA.properties).some(key => Object.hasOwn(value, key))
    // WebChat may strip formatting tags. A naked tool-shaped object is never
    // evidence of a final answer or permission to execute a host tool.
    && !(typeof value.name === 'string' && Object.hasOwn(value, 'arguments'))
    && !Object.hasOwn(value, 'tool_calls') && !Object.hasOwn(value, 'function_call');
}

export function parseStrictContract(text: string, normalizeResult = false): AgentContractResponse {
  try {
    const parsed = parseContractJson(text);
    if (normalizeResult && !parsed.repaired && isBareStructuredResult(parsed.value)) {
      // Mechanical wrapping preserves all result data and cannot create a tool
      // call, loop or permission. Schema and tool checks still run below.
      return validateContractShape({action:'final_response',tool:null,tool_input:null,
        content:parsed.value,reasoning_summary:'',loop:null});
    }
    return validateContractShape(parsed.value);
  } catch (error) {
    if (error instanceof AgentContractValidationError) throw error;
    throw new AgentContractValidationError(
      `${INVALID_CONTRACT_MESSAGE} ${error instanceof Error ? error.message : String(error)}`,
      error instanceof ContractJsonError ? error.kind : 'shape'
    );
  }
}

function validateContractShape(parsed: unknown): AgentContractResponse {
  const validation = validateJsonSchema(parsed, AGENT_RESPONSE_SCHEMA);
  if (!validation.valid) {
    const detail = validation.issues.slice(0, 6).map(issue => `${issue.path}: ${issue.message}`).join('; ');
    throw new AgentContractValidationError(`Invalid Agent response shape: ${detail}`, 'shape', validation.issues.map(issue => issue.path));
  }
  const value = parsed as unknown as AgentContractResponse;
  if (sentenceCount(value.reasoning_summary) > 2) {
    // This is public-facing presentation metadata, not authorization, tool
    // input, execution evidence or result data. Normalize only this field
    // mechanically: needless model retries on a third sentence must not
    // replay a large WebChat request or replace an otherwise valid action.
    const sentences = value.reasoning_summary.trim().split(/(?<=[.!?])\s+/u)
      .filter(part => part.trim());
    return { ...value, reasoning_summary: sentences.slice(0, 2).join(' ') };
  }
  return value;
}

export function validateContractResponse(response: AgentContractResponse, plan: AgentContractPlan): void {
  if (response.action === 'use_tool') {
    if (!response.tool || response.tool_input === null) {
      throw new AgentContractValidationError('use_tool requires tool and tool_input.', 'shape', [...(!response.tool ? ['$/tool'] : []), ...(response.tool_input === null ? ['$/tool_input'] : [])]);
    }
    const tool = plan.tools.get(response.tool);
    if (!tool) throw new AgentContractValidationError(`Tool unavailable for this turn: ${response.tool}.`, 'schema', ['$/tool', '$/tool_input']);
    if (Buffer.byteLength(JSON.stringify(response.tool_input), 'utf8') > MAX_TOOL_ARGUMENT_BYTES) {
      throw new AgentContractValidationError(
        'Serialized tool_input exceeds 64 KiB. Split the change into smaller tool calls.',
        'schema', ['$/tool_input']
      );
    }
    if (tool.parameters !== undefined) {
      const validation = validateJsonSchema(response.tool_input, tool.parameters);
      if (!validation.valid) {
        const detail = validation.issues.slice(0, 6).map((issue) => `${issue.path}: ${issue.message}`).join('; ');
        throw new AgentContractValidationError(`Invalid tool_input for ${response.tool}${detail ? `: ${detail}` : ''}.`, 'schema', validation.issues.map(issue => '$/tool_input' + issue.path.slice(1)));
      }
    }
    if (response.content !== null) throw new AgentContractValidationError('use_tool requires content=null.', 'shape', ['$/content']);
    return;
  }

  if (response.tool !== null || response.tool_input !== null) {
    throw new AgentContractValidationError(`${response.action} requires tool=null and tool_input=null.`, 'shape', ['$/tool', '$/tool_input']);
  }
  if (response.action === 'final_response' && (response.content === null
      || (typeof response.content === 'string' && !response.content.trim())
      || (isRecord(response.content) && Object.keys(response.content).length === 0))) {
    throw new AgentContractValidationError('final_response requires non-empty content.', 'shape', ['$/content']);
  }
}



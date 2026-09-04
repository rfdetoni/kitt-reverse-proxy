import {
  ToolProtocolError,
  type CanonicalFunctionTool,
  type OpenAiToolCall,
  type ToolProtocolPlan
} from '../mapping/tool-calling.js';
import type { CanonicalMessage } from './ui-history.js';

export type ToolEnforcementMode = 'auto' | 'explore-first' | 'required';

const EXPLORATION_NAME =
  /(?:^|[_.:-])(read|list|search|grep|glob|find|scan|inspect|lookup|query|tree|stat|cat|head|tail)(?:$|[_.:-])/i;
const MUTATION_NAME =
  /(?:^|[_.:-])(write|edit|patch|apply|create|delete|remove|move|rename|mkdir|touch|replace)(?:$|[_.:-])/i;
const MIXED_SHELL_NAME =
  /^(?:execute_command|run_command|exec|shell|bash|terminal|command)$/i;

const WORKSPACE_REFERENCE =
  /\b(?:workspace|repo(?:sitory)?|codebase|project|projeto|src|source tree|working tree|arquivo(?:s)?|file(?:s)?|diret[oó]rio|directory|pasta|module|m[oó]dulo)\b/i;
const CODE_NOUN =
  /\b(?:class|classe|method|m[eé]todo|function|fun[cç][aã]o|endpoint|controller|service|repository|component|package|dependency|depend[eê]ncia|test|teste|bug|build|script|migration|migra[cç][aã]o|schema|query)\b/i;
const CHANGE_INTENT =
  /\b(?:fix|corrig(?:ir|a|e|indo)?|implement(?:ar|e|a)?|add|adicion(?:ar|e|a)?|remove|remov(?:er|a)|refactor|refator(?:ar|e)|improve|melhor(?:ar|e)|aprimor(?:ar|e)|change|alter(?:ar|e)|edit|editar|create|criar|update|atualiz(?:ar|e)|review|revis(?:ar|e)|debug|investig(?:ar|ue)|resolve|resolver)\b/i;
const PATH_LIKE =
  /(?:^|[\s"'`])(?:\.{0,2}\/|src\/|test\/|tests\/|lib\/|app\/|packages\/|[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|java|kt|kts|py|rs|go|cs|cpp|c|h|hpp|json|ya?ml|toml|xml|gradle|md|sql))(?:$|[\s"'`,:;])/i;

const READ_ONLY_COMMAND =
  /^(?:(?:rtk\s+)?(?:pwd|ls|tree|rg|grep|find|cat|head|tail|wc|file|stat)\b|git\s+(?:status|diff|log|show|branch\b|rev-parse\b|ls-files\b)|sed\s+-n\b)/i;
const SHELL_CONTROL_OR_WRITE =
  /(?:[;&|><`]|\$\(|\b(?:rm|mv|cp|mkdir|touch|truncate|tee|chmod|chown|sed\s+-i|perl\s+-pi|git\s+(?:checkout|switch|reset|clean|commit|merge|rebase|apply)|npm\s+(?:install|uninstall|update)|pnpm\s+(?:add|remove|install)|yarn\s+(?:add|remove|install))\b)/i;

export class ToolEnforcementError extends ToolProtocolError {
  readonly code = 'tool_required_but_not_called';

  constructor(
    message: string,
    public readonly reason:
      | 'exploration_required'
      | 'read_before_write'
      | 'tool_required'
  ) {
    super(message, 'model');
    this.name = 'ToolEnforcementError';
  }
}

export interface ToolEnforcementPlan {
  enabled: boolean;
  mode: ToolEnforcementMode;
  workspaceDependent: boolean;
  requireExploration: boolean;
  requireAnyTool: boolean;
  explorationToolNames: string[];
}

function toolDescriptor(tool: CanonicalFunctionTool): string {
  return `${tool.name} ${tool.description ?? ''}`.trim();
}

function isDedicatedExplorationTool(tool: CanonicalFunctionTool): boolean {
  const descriptor = toolDescriptor(tool);
  return EXPLORATION_NAME.test(tool.name)
    || /\b(?:read|list|search|grep|glob|find|inspect|lookup|query|scan)\b/i.test(descriptor);
}

function isDedicatedMutationTool(tool: CanonicalFunctionTool): boolean {
  const descriptor = toolDescriptor(tool);
  return MUTATION_NAME.test(tool.name)
    || /\b(?:write|edit|patch|create|delete|remove|rename|modify|update file)\b/i.test(descriptor);
}

function isMixedShellTool(tool: CanonicalFunctionTool): boolean {
  return MIXED_SHELL_NAME.test(tool.name);
}

function parseArguments(call: OpenAiToolCall): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(call.function.arguments) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function commandFromCall(call: OpenAiToolCall): string | undefined {
  const args = parseArguments(call);
  if (!args) return undefined;
  for (const key of ['command', 'cmd', 'script', 'input']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function isReadOnlyShellCommand(command: string | undefined): boolean {
  if (!command || command.length > 8_192) return false;
  if (SHELL_CONTROL_OR_WRITE.test(command)) return false;
  return READ_ONLY_COMMAND.test(command.trim());
}

function isMutatingShellCommand(command: string | undefined): boolean {
  if (!command) return false;
  return SHELL_CONTROL_OR_WRITE.test(command);
}

export function isWorkspaceDependentRequest(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  if (PATH_LIKE.test(normalized)) return true;
  if (WORKSPACE_REFERENCE.test(normalized)) return true;
  return CHANGE_INTENT.test(normalized) && CODE_NOUN.test(normalized);
}

export function toolEnforcementTaskKey(messages: readonly CanonicalMessage[]): string {
  let userCount = 0;
  let lastUser = '';
  for (const message of messages) {
    if (message.role === 'user') {
      userCount += 1;
      lastUser = message.text;
    }
  }
  return `${userCount}:${lastUser}`;
}

export function buildToolEnforcementPlan(
  plan: ToolProtocolPlan,
  latestUserText: string,
  mode: ToolEnforcementMode
): ToolEnforcementPlan {
  if (mode === 'auto' || !plan.tools.length || plan.choice.mode === 'none') {
    return {
      enabled: false,
      mode,
      workspaceDependent: false,
      requireExploration: false,
      requireAnyTool: false,
      explorationToolNames: []
    };
  }

  const workspaceDependent = isWorkspaceDependentRequest(latestUserText);
  const explorationTools = plan.tools.filter((tool) =>
    isDedicatedExplorationTool(tool) || isMixedShellTool(tool)
  );

  const requireExploration = explorationTools.length > 0 && workspaceDependent;

  return {
    enabled: mode === 'required' || workspaceDependent,
    mode,
    workspaceDependent,
    requireExploration,
    requireAnyTool: mode === 'required',
    explorationToolNames: explorationTools.map((tool) => tool.name)
  };
}

export function isExplorationToolCall(
  call: OpenAiToolCall,
  plan: ToolProtocolPlan
): boolean {
  const tool = plan.tools.find((candidate) => candidate.name === call.function.name);
  if (!tool) return false;
  if (isDedicatedExplorationTool(tool)) return true;
  if (isMixedShellTool(tool)) return isReadOnlyShellCommand(commandFromCall(call));
  return false;
}

export function isMutationToolCall(
  call: OpenAiToolCall,
  plan: ToolProtocolPlan
): boolean {
  const tool = plan.tools.find((candidate) => candidate.name === call.function.name);
  if (!tool) return false;
  if (isDedicatedMutationTool(tool)) return true;
  if (isMixedShellTool(tool)) return isMutatingShellCommand(commandFromCall(call));
  return false;
}

export function enforceToolResponse(input: {
  enforcement: ToolEnforcementPlan;
  protocol: ToolProtocolPlan;
  calls: readonly OpenAiToolCall[] | undefined;
  explorationEvidence: boolean;
  toolEvidence: boolean;
}): void {
  const {
    enforcement,
    protocol,
    calls = [],
    explorationEvidence,
    toolEvidence
  } = input;

  if (!enforcement.enabled) return;

  if (enforcement.requireExploration && !explorationEvidence) {
    const mutations = calls.filter((call) => isMutationToolCall(call, protocol));
    if (mutations.length > 0) {
      throw new ToolEnforcementError(
        `Workspace exploration is required before mutation. Premature mutation tool(s): ${mutations.map((call) => call.function.name).join(', ')}.`,
        'read_before_write'
      );
    }

    const explorationCalls = calls.filter((call) => isExplorationToolCall(call, protocol));
    if (explorationCalls.length === 0) {
      throw new ToolEnforcementError(
        `The task depends on the workspace. Call an exploration tool before producing a final answer. Available exploration tools: ${enforcement.explorationToolNames.join(', ') || '(none)'}.`,
        'exploration_required'
      );
    }
    return;
  }

  if (enforcement.requireAnyTool && !toolEvidence && calls.length === 0) {
    throw new ToolEnforcementError(
      'At least one tool call is required before a final answer for this turn.',
      'tool_required'
    );
  }
}

export function buildToolEnforcementDirective(
  enforcement: ToolEnforcementPlan,
  explorationEvidence: boolean,
  toolEvidence: boolean
): string {
  if (!enforcement.enabled) return '';

  const lines = [
    '[KITT TOOL ENFORCEMENT]',
    `mode=${enforcement.mode}`,
    'This policy is enforced by the proxy, not merely suggested by the prompt.'
  ];

  if (enforcement.requireExploration && !explorationEvidence) {
    lines.push(
      'You MUST inspect the real workspace before any final answer or mutating tool call.',
      `Use one of these exploration tools first: ${enforcement.explorationToolNames.join(', ')}.`,
      'Return only the required exploration tool call now. Do not explain what you intend to do.'
    );
  } else if (enforcement.requireAnyTool && !toolEvidence) {
    lines.push(
      'You MUST call at least one available tool before returning a final answer.',
      'Return only a tool call now.'
    );
  }

  lines.push('[END KITT TOOL ENFORCEMENT]');
  return `${lines.join('\n')}\n\n`;
}

export function buildToolEnforcementRetryPrompt(
  enforcement: ToolEnforcementPlan,
  error: ToolEnforcementError
): string {
  const exploration = enforcement.explorationToolNames.join(', ');
  if (error.reason === 'read_before_write') {
    return [
      '[KITT ENFORCEMENT RETRY]',
      'Your previous response attempted to modify the workspace before inspecting it.',
      `Call an exploration tool first${exploration ? ` (${exploration})` : ''}.`,
      'Do not call write/edit/patch/create/delete tools yet.',
      'Do not provide a final answer.',
      '[END KITT ENFORCEMENT RETRY]'
    ].join('\n');
  }

  if (error.reason === 'exploration_required') {
    return [
      '[KITT ENFORCEMENT RETRY]',
      'Your previous response answered without obtaining evidence from the workspace.',
      `Call one exploration tool now${exploration ? `: ${exploration}` : '.'}`,
      'Do not provide explanation or a final answer.',
      '[END KITT ENFORCEMENT RETRY]'
    ].join('\n');
  }

  return [
    '[KITT ENFORCEMENT RETRY]',
    'Your previous response did not call a required tool.',
    'Call one available tool now and return no final answer.',
    '[END KITT ENFORCEMENT RETRY]'
  ].join('\n');
}

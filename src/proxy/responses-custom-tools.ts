import type { JsonObject, JsonValue } from '../types.js';

const TOOL_NAME = /^[a-zA-Z0-9_.:-]{1,64}$/;

export interface PreparedCustomTools {
  source: JsonObject;
  names: ReadonlySet<string>;
}

/** Adapt free-form Responses custom tools to KITT's function-only WebChat transport. */
export function prepareCustomTools(source: JsonObject): PreparedCustomTools {
  const names = new Set<string>();
  const tools: JsonValue[] = (Array.isArray(source.tools) ? source.tools : []).map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.type !== 'custom') return value;
    if (typeof value.name !== 'string' || !TOOL_NAME.test(value.name)) {
      throw new Error('Responses custom tool requires a valid name.');
    }
    if (names.has(value.name)) throw new Error('Duplicate Responses custom tool name.');
    names.add(value.name);
    if (value.format !== undefined && (
      typeof value.format !== 'object' || value.format === null || Array.isArray(value.format)
      || value.format.type !== 'text'
    )) throw new Error('Only free-form text custom tools are supported by the WebChat bridge.');
    return {
      type: 'function',
      name: value.name,
      description: (typeof value.description === 'string' ? value.description : '') +
        ' Supply free-form tool input as a string field named "input".',
      parameters: {
        type: 'object',
        properties: { input: { type: 'string' } },
        required: ['input'],
        additionalProperties: false
      },
      strict: true
    };
  });
  if (!names.size) return { source, names };
  const choice = source.tool_choice;
  const adaptedChoice = choice && typeof choice === 'object' && !Array.isArray(choice)
    && choice.type === 'custom' && typeof choice.name === 'string'
    ? { type: 'function', name: choice.name }
    : choice;
  return { source: { ...source, tools, ...(adaptedChoice !== undefined ? { tool_choice: adaptedChoice } : {}) }, names };
}

import { randomUUID } from 'node:crypto';
import type { JsonValue } from '../types.js';

export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ParsedModelOutput {
  content: string | null;
  tool_calls?: OpenAiToolCall[];
}

export interface ApiDirectiveOptions {
  tools?: JsonValue[] | undefined;
  systemPrompt?: string | undefined;
}

export function formatToolsInstruction(tools: JsonValue[] | undefined): string {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  return `[SYSTEM DIRECTIVE: Act strictly as an AI API engine with function calling capabilities.
Available Tools:
${JSON.stringify(tools, null, 2)}

API PROTOCOL RULES:
1. When you need to execute one or more tools, output ONLY the tool invocation block without conversational preamble or trailing remarks.
2. Format tool invocations using this exact JSON structure:
\`\`\`json
{
  "tool_calls": [
    {
      "name": "tool_name",
      "arguments": { "param_key": "param_value" }
    }
  ]
}
\`\`\`
Or using tags:
<tool_call>
{"name": "tool_name", "arguments": { ... }}
</tool_call>
3. If no tool is required, respond directly with your normal answer.]\n\n`;
}

export function formatApiDirective(options: ApiDirectiveOptions): string {
  const parts: string[] = [];

  parts.push('[SYSTEM DIRECTIVE: Act strictly as an AI API engine. Respond directly, concisely, and accurately without conversational filler, greetings, or preamble.');

  if (options.systemPrompt && options.systemPrompt.trim()) {
    parts.push(`System Context:\n${options.systemPrompt.trim()}`);
  }

  if (Array.isArray(options.tools) && options.tools.length > 0) {
    parts.push(`Available Tools:\n${JSON.stringify(options.tools, null, 2)}

API PROTOCOL RULES:
1. When you need to execute tools, output ONLY the tool invocation block without conversational remarks.
2. Use this exact JSON structure:
\`\`\`json
{
  "tool_calls": [
    {
      "name": "tool_name",
      "arguments": { "param_key": "param_value" }
    }
  ]
}
\`\`\`
Or tags:
<tool_call>
{"name": "tool_name", "arguments": { ... }}
</tool_call>
3. If no tool is required, respond directly with your normal answer.`);
  } else {
    parts.push(`If you need to invoke tools/functions, use <tool_call>{"name": "tool_name", "arguments": {...}}</tool_call> or \`\`\`json\n{"tool_calls": [...]}\n\`\`\`. Otherwise, respond directly.`);
  }

  parts.push(']\n\n');
  return parts.join('\n\n');
}

export function injectToolsIntoPrompt(prompt: string, toolsOrOptions?: JsonValue[] | ApiDirectiveOptions | undefined): string {
  if (Array.isArray(toolsOrOptions)) {
    return `${formatApiDirective({ tools: toolsOrOptions })}${prompt}`;
  }
  const options = toolsOrOptions ?? {};
  return `${formatApiDirective(options)}${prompt}`;
}

export function extractToolCalls(text: string): ParsedModelOutput {
  if (!text || !text.trim()) return { content: text || '' };

  const toolCalls: OpenAiToolCall[] = [];
  let remainingText = text;

  // 1. Check for <tool_call>...</tool_call> tags
  const tagRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]!.trim());
      if (parsed && typeof parsed.name === 'string') {
        toolCalls.push({
          id: `call_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
          type: 'function',
          function: {
            name: parsed.name,
            arguments: typeof parsed.arguments === 'object' ? JSON.stringify(parsed.arguments) : String(parsed.arguments || '{}')
          }
        });
        remainingText = remainingText.replace(match[0], '');
      } else if (parsed && Array.isArray(parsed.tool_calls)) {
        for (const call of parsed.tool_calls) {
          if (call && typeof call.name === 'string') {
            toolCalls.push({
              id: `call_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
              type: 'function',
              function: {
                name: call.name,
                arguments: typeof call.arguments === 'object' ? JSON.stringify(call.arguments) : String(call.arguments || '{}')
              }
            });
          }
        }
        remainingText = remainingText.replace(match[0], '');
      }
    } catch {}
  }

  if (toolCalls.length > 0) {
    const trimmed = remainingText.trim();
    return { content: trimmed ? trimmed : null, tool_calls: toolCalls };
  }

  // 2. Check for ```json ... ``` blocks containing tool_calls or function calls
  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]!.trim());
      if (parsed && Array.isArray(parsed.tool_calls)) {
        for (const call of parsed.tool_calls) {
          if (call && typeof call.name === 'string') {
            toolCalls.push({
              id: `call_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
              type: 'function',
              function: {
                name: call.name,
                arguments: typeof call.arguments === 'object' ? JSON.stringify(call.arguments) : String(call.arguments || '{}')
              }
            });
          }
        }
        remainingText = remainingText.replace(match[0], '');
      } else if (parsed && typeof parsed.name === 'string' && (parsed.arguments !== undefined || parsed.parameters !== undefined)) {
        toolCalls.push({
          id: `call_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
          type: 'function',
          function: {
            name: parsed.name,
            arguments: JSON.stringify(parsed.arguments || parsed.parameters || {})
          }
        });
        remainingText = remainingText.replace(match[0], '');
      }
    } catch {}
  }

  if (toolCalls.length > 0) {
    const trimmed = remainingText.trim();
    return { content: trimmed ? trimmed : null, tool_calls: toolCalls };
  }

  // 3. Check for raw JSON object at the start/end or entire response
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && Array.isArray(parsed.tool_calls)) {
        for (const call of parsed.tool_calls) {
          if (call && typeof call.name === 'string') {
            toolCalls.push({
              id: `call_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
              type: 'function',
              function: {
                name: call.name,
                arguments: typeof call.arguments === 'object' ? JSON.stringify(call.arguments) : String(call.arguments || '{}')
              }
            });
          }
        }
        return { content: null, tool_calls: toolCalls };
      }
    } catch {}
  }

  return { content: text };
}

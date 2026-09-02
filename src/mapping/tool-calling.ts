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

export function formatToolsInstruction(tools: JsonValue[] | undefined): string {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  return `[INSTRUCTION: You have access to the following tools/functions:
${JSON.stringify(tools, null, 2)}

To call a tool, respond ONLY with a JSON block in this exact format:
\`\`\`json
{
  "tool_calls": [
    {
      "name": "function_name",
      "arguments": { "arg_name": "value" }
    }
  ]
}
\`\`\`
Or using tags:
<tool_call>
{"name": "function_name", "arguments": { ... }}
</tool_call>
If no tool is needed, respond with standard text.]\n\n`;
}

export function injectToolsIntoPrompt(prompt: string, tools: JsonValue[] | undefined): string {
  const instruction = formatToolsInstruction(tools);
  if (!instruction) return prompt;
  return `${instruction}${prompt}`;
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

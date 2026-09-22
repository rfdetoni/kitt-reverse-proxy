import { CHATGPT_PLUGIN } from './chatgpt.js';
import { CLAUDE_PLUGIN } from './claude.js';
import { DEEPSEEK_PLUGIN } from './deepseek.js';
import { GEMINI_PLUGIN } from './gemini.js';
import { GENERIC_PLUGIN } from './generic.js';
import { KIMI_PLUGIN } from './kimi.js';

export {
  CHATGPT_PLUGIN,
  CLAUDE_PLUGIN,
  DEEPSEEK_PLUGIN,
  GEMINI_PLUGIN,
  GENERIC_PLUGIN,
  KIMI_PLUGIN
};

export const DEFAULT_PROVIDER_PLUGINS = Object.freeze([
  CHATGPT_PLUGIN,
  CLAUDE_PLUGIN,
  GEMINI_PLUGIN,
  KIMI_PLUGIN,
  DEEPSEEK_PLUGIN,
  GENERIC_PLUGIN
]);

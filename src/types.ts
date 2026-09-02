import type { Browser, BrowserContext, Page } from 'playwright';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type TransportMode = 'auto' | 'network' | 'ui';
export type ProviderId = 'auto' | 'generic' | 'chatgpt' | 'claude' | 'gemini' | 'kimi' | 'deepseek';

export interface AppConfig {
  targetUrl: string;
  model: string;
  apiModel?: string;
  ollamaUrl: string;
  host: string;
  port: number;
  captureTimeoutMs: number;
  settleAfterCandidateMs: number;
  responseSampleTimeoutMs: number;
  ollamaTimeoutMs: number;
  upstreamTimeoutMs: number;
  uiResponseTimeoutMs: number;
  uiSettleMs: number;
  manualInterventionTimeoutMs: number;
  headed: boolean;
  cors: boolean;
  apiKey?: string;
  profilePath?: string;
  saveProfilePath?: string;
  userDataDir?: string;
  cdpUrl?: string;
  maxQueue: number;
  minIntervalMs: number;
  allowedEndpointHosts: string[];
  followRedirects: boolean;
  provider: ProviderId;
  transport: TransportMode;
}

export interface RequestBodyCodecDescriptor {
  kind: 'json' | 'form';
  jsonStringPaths: string[];
  repeatedFormKeys?: string[];
  formFieldOrder?: string[];
}

export interface CapturedExchange {
  endpointUrl: string;
  headers: Record<string, string>;
  requestSample: JsonObject;
  requestCodec: RequestBodyCodecDescriptor;
  responseSample: JsonValue | null;
  responseHeaders: Record<string, string>;
  score: number;
  requestContentType: string;
  responseContentType: string;
}

export interface LiveBrowserSession {
  browser?: Browser;
  context: BrowserContext;
  page: Page;
  persistent: boolean;
  close(): Promise<void>;
}

export type BindingSource =
  | 'openai.messages'
  | 'openai.last_user_text'
  | 'openai.last_message_text'
  | 'openai.transcript'
  | 'openai.system_text'
  | 'openai.model'
  | 'openai.temperature'
  | 'openai.top_p'
  | 'openai.max_tokens'
  | 'openai.stream'
  | 'openai.tools_json'
  | 'openai.tool_choice_json'
  | 'generated.uuid'
  | 'generated.request_id'
  | 'generated.timestamp_ms'
  | 'generated.timestamp_s';

export interface MessageArrayTransform {
  type: 'message_array';
  rolePath: string;
  contentPath: string;
  roleMap?: Partial<Record<'system' | 'developer' | 'user' | 'assistant' | 'tool', string>>;
  includeSystem?: boolean;
}

export interface IdentityTransform {
  type: 'identity';
}

export interface StringTransform {
  type: 'string';
}

export type BindingTransform = MessageArrayTransform | IdentityTransform | StringTransform;

export interface RequestBinding {
  target: string;
  source: BindingSource;
  optional?: boolean;
  transform?: BindingTransform;
}

export interface StateUpdate {
  responsePath: string;
  requestTarget: string;
  optional?: boolean;
}

export type JoinStrategy = 'smart' | 'concat' | 'first' | 'last';

export interface AdapterProfile {
  version: 2;
  request: {
    bindings: RequestBinding[];
    removePaths?: string[];
  };
  response: {
    contentPaths: string[];
    joinStrategy?: JoinStrategy;
    separator?: string;
    finishReasonPath?: string;
    idPath?: string;
  };
  state?: {
    updates?: StateUpdate[];
  };
  metadata?: {
    targetHost?: string;
    endpointPath?: string;
    generatedBy?: string;
  };
}

export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown;
}

export interface OpenAiChatBody extends JsonObject {
  model?: JsonValue;
  messages: JsonValue[];
  stream?: JsonValue;
  temperature?: JsonValue;
  top_p?: JsonValue;
  max_tokens?: JsonValue;
  max_completion_tokens?: JsonValue;
  tools?: JsonValue;
  tool_choice?: JsonValue;
}

export interface OpenAiCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string;
    };
    finish_reason: string | null;
  }>;
}

export interface OpenAiCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
    };
    finish_reason: string | null;
  }>;
}

export interface UpstreamResult {
  status: number;
  headers: Record<string, string>;
  contentType: string;
  body: JsonValue;
}

export interface ChatExecutionOptions {
  onDelta?: (delta: string) => void | Promise<void>;
}

export interface ChatExecutionResult {
  completion: OpenAiCompletion;
  deltas: string[];
}

export interface ChatExecutor {
  readonly modelId: string;
  readonly transport: 'network' | 'ui';
  execute(body: JsonObject, options?: ChatExecutionOptions): Promise<ChatExecutionResult>;
  describe(): JsonObject;
  reset?(): Promise<void>;
}

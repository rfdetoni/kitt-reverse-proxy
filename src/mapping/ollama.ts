import type { AdapterProfile, AppConfig, CapturedExchange } from '../types.js';
import { redactForModel, redactHeadersForModel } from '../security/redaction.js';
import { parseProfileText } from './profile.js';

function buildPrompt(capture: CapturedExchange): string {
  const endpoint = new URL(capture.endpointUrl);
  return `You are generating a DECLARATIVE mapping profile for a local OpenAI-compatible adapter.
Return STRICT JSON only. No markdown. Never return JavaScript or executable code.

Schema:
{
  "version": 2,
  "request": {
    "bindings": [
      {
        "target": "$.target.path",
        "source": "openai.last_user_text | openai.last_message_text | openai.messages | openai.transcript | openai.system_text | openai.model | openai.temperature | openai.top_p | openai.max_tokens | openai.stream | openai.tools_json | openai.tool_choice_json | generated.uuid | generated.request_id | generated.timestamp_ms | generated.timestamp_s",
        "optional": true,
        "transform": {"type":"identity|string|message_array","rolePath":"$.role","contentPath":"$.content","roleMap":{"user":"user","assistant":"assistant","system":"system","tool":"tool"},"includeSystem":true}
      }
    ],
    "removePaths": []
  },
  "response": {
    "contentPaths": ["$.answer.text", "$.eventStream[*].delta.content"],
    "joinStrategy": "smart | concat | first | last",
    "separator": "",
    "finishReasonPath": "$.optional.path",
    "idPath": "$.optional.path"
  },
  "state": {
    "updates": [{"responsePath":"$.conversationId","requestTarget":"$.conversationId","optional":true}]
  }
}

Rules:
- JSON paths support numeric indexes and quoted keys, e.g. $["f.req"][0][1].
- Start from the captured request shape conceptually; bindings overwrite dynamic fields. Do not include the captured request body itself in the profile.
- At least one request binding MUST carry user conversation content.
- Prefer openai.messages if the target accepts an array of chat messages.
- Use message_array transform when target accepts a message array. rolePath/contentPath are JSON paths RELATIVE TO EACH target message, so nested shapes such as $.parts[0].text are supported.
- Use openai.last_user_text for stateful web chat APIs that only submit the new user turn.
- Use openai.transcript only for a single string prompt that needs history.
- If request contains per-message/request UUID or timestamp fields, bind them to generated.*.
- Conversation/thread/session IDs that are returned by the response and reused in the next request belong in state.updates, NOT generated.*.
- response.contentPaths may use [*] for streamed event arrays. Use joinStrategy smart for deltas/cumulative snapshots unless clearly inappropriate.
- Do not map secrets, cookies, CSRF tokens, authorization headers, or browser/session headers. Those are handled outside this profile.
- Do not invent target paths not supported by the sample, except when absolutely necessary for an obvious messages fallback.
- Profiles are data only and must contain no code.

TARGET HOST: ${endpoint.hostname}
TARGET ENDPOINT PATH: ${endpoint.pathname}
REQUEST CONTENT TYPE: ${capture.requestContentType}
REQUEST BODY CODEC: ${capture.requestCodec.kind}
RESPONSE CONTENT TYPE: ${capture.responseContentType}
REQUEST HEADERS SHAPE: ${JSON.stringify(redactHeadersForModel(capture.headers), null, 2)}
REQUEST SAMPLE (values redacted where appropriate):
${JSON.stringify(redactForModel(capture.requestSample), null, 2)}
RESPONSE SAMPLE (values redacted where appropriate):
${JSON.stringify(capture.responseSample == null ? null : redactForModel(capture.responseSample), null, 2)}
`;
}

export async function generateProfile(capture: CapturedExchange, config: AppConfig): Promise<AdapterProfile> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.ollamaTimeoutMs);
  try {
    const response = await fetch(config.ollamaUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        prompt: buildPrompt(capture),
        stream: false,
        format: 'json',
        options: { temperature: 0 }
      }),
      signal: controller.signal,
      redirect: 'error'
    });
    if (!response.ok) throw new Error(`Ollama respondeu HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
    const envelope = await response.json() as { response?: unknown };
    if (typeof envelope.response !== 'string') throw new Error('Resposta Ollama sem campo string "response".');
    return parseProfileText(envelope.response);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Timeout do Ollama após ${config.ollamaTimeoutMs / 1000}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

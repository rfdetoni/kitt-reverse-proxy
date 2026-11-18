# Decision models + temporary WebChat conversations

## Purpose

K.I.T.T. can combine a **typed decision model and a generative LLM in the same request**. Ollaya classifies a request (domain, difficulty, tool requirement, sensitivity), while the original LLM remains responsible for reasoning and generating tool calls or natural language. The model never grants permission to execute a tool.

## Setup

Install Ollaya from https://ollaya.dev/ and pull a model, e.g. `ollaya pull laya`. Ollaya's /api/decide endpoint does not auto-pull.

Set the following variables on the reverse proxy:

- `PROXY_DECISION_MODE=assist` (off, shadow, assist; default off).
- `PROXY_DECISION_URL=http://127.0.0.1:11435` (in Docker use `http://ollaya:11435`).
- `PROXY_DECISION_MODEL=laya` (must already be downloaded).
- `PROXY_DECISION_TIMEOUT_MS=2500` (100–30000).
- `PROXY_DECISION_API_KEY` if Ollaya requires a bearer key.
- `PROXY_TEMPORARY_CHAT=supported` (off, supported, required; default off).

Start ChatGPT with `kitt-reverse-proxy start chatgpt --transport ui` when temporary-chat mode is enabled.

## Cooperation behavior

- The advisor receives **only the latest plain-text user message** up to 4096 characters; it never receives tool outputs, image payloads, entire conversations or browser credentials.
- One Ollaya POST /api/decide call uses preset `router`; signals are validated before use.
- `shadow` classifies without changing the request. `assist` adds a short advisory system message on ordinary OpenAI Chat Completions and Responses. The strict K.I.T.T. Agent contract retains the original request wire unchanged; in assist mode, the advisor is applied to the generated transport prompt only after contract validation. In shadow mode the result is observed without injection.
- A timeout or invalid/unavailable decision leaves the LLM request unchanged. It never replays a dispatched LLM call.
- A response header `X-Kitt-Decision-Status` reports off, skipped, shadow, assisted or unavailable. `/v1/capabilities` advertises both integrations.
- Decision confidences are *not* authorizations or safety guarantees; existing tool permissions and approvals remain authoritative.

## Temporary chats

When `PROXY_TEMPORARY_CHAT` is supported or required, the ChatGPT UI transport navigates to the temporary-chat route before any prompt and requires visible UI confirmation. If confirmation fails, **the prompt is not sent**, rather than silently using a saved conversation.

Named K.I.T.T. sessions maintain the same temporary conversation through consecutive LLM and tool turns. Reset opens another temporary conversation. Authenticated browser cookies are reused within the dedicated K.I.T.T. profile; temporary chat is not a substitute for browser-profile or tenant isolation.

Only **ChatGPT UI** is verified in this first implementation. `required` rejects unsupported providers. `supported` leaves unsupported providers on their prior behavior. ChatGPT network transport is rejected while this feature is active. Provider-side temporary chats can still have limited retention under the provider's privacy policy; do not promise zero retention.

## Verification

Run `npm run verify`; unit tests cover typed decisions, timeouts/fallbacks, strict-contract preservation, the temporary mode confirmation, and unsupported-provider behavior. Before production, run live authenticated browser acceptance with two named sessions, a tool-result continuation, an explicit reset and temporary UI state verification. Website selectors may change without notice.

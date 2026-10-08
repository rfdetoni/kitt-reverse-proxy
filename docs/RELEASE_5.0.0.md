# kitt-reverse-proxy 5.0.0 — Agent contract v3

Contract v3 accepts structured result objects directly in content. The model emits one JSON representation instead of escaping JSON inside a string. The Proxy serializes object-valued content into standard OpenAI message text in host code. Ordinary text answers and tool actions retain their existing semantics.

Protocol 0.10.0 owns the mandatory response schema and identifiers. Shared schema validation replaces duplicated local shape checks; reasoning-summary and action/tool checks remain. Bounded resilient recovery accepts exactly one shape-valid interpretation. Competing optional tool arguments, duplicate fields and incomplete payloads remain invalid.

Unsupported nonempty X-Kitt-Agent-Contract versions return 400 agent_contract_version_mismatch without provider execution. Generic API clients that omit the header use standard OpenAI routes. Upgrade Agent to 0.85.0 and align consumers; no v2 negotiation is provided. WebChat still owns token limits.

209 tests, TypeScript checks and production build passed. HTTP integration preserves structured plan/review/validation objects, quotes and whitespace in one attempt, and v2 requests never reach the provider. Raw-quote recovery and competing-tool-argument rejection remain covered. CI checks generated schema parity and real Chromium. No fresh authenticated Gemini session was executed locally.

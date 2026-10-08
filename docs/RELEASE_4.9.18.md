# kitt-reverse-proxy 4.9.18 — WebChat owns token limits

The proxy no longer stops request submission because of estimated prompt tokens. WebChat owns context and output token limits. Legacy max_prompt_tokens metadata and lifecycle maxPromptTokens input are accepted during rolling upgrades and ignored. Token estimates and replay accounting remain available for observability.

Attempt counts, whole-request deadlines, cancellation, queue/session capacity, byte limits, schema validation and idempotency remain enforced. No shared wire schema or provider login behavior changes.

## Validation

All 206 tests passed with TypeScript checks and production build. Lifecycle regressions exceed the former million-token ceiling and a legacy one-token allowance while still rejecting an extra attempt and expired requests. Authenticated live WebChat sessions were not exercised locally.

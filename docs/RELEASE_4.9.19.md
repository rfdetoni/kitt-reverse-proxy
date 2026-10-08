# kitt-reverse-proxy 4.9.19 — Nested JSON contract recovery

The supplied Gemini response returned a plan-review verdict as JSON inside the outer content string without escaping its quotes. Its two repair attempts repeated the defect. The generic recovery parser correctly detected multiple possible parses, including alternatives that swallowed required reasoning_summary and loop fields.

Agent-contract decoding now uses the existing mandatory contract shape to exclude those invalid alternatives. A unique matching interpretation is recovered locally with every string value preserved. Two matching interpretations remain ambiguous; optional tool arguments are never selected using their tool schema. Generic JSON parsing retains its previous conservative behavior, and duplicate keys, incomplete payloads and resource limits remain rejected.

Action and loop status now require actual string values rather than accepting arrays through string coercion. Model instructions explicitly require escaping quotes and backslashes inside nested JSON strings. No wire schema, Agent dependency or token policy changes: WebChat still owns token limits.

## Validation

All 208 Proxy tests, TypeScript checks and production build passed. HTTP integration reproduces the unescaped verdict and returns its exact content in one attempt; a competing interpretation of optional tool arguments still returns a recoverable error without executing a tool. Canonical-shape tests reject array-valued action and status. All three supplied failed responses were replayed locally and decoded successfully. No fresh authenticated Gemini session was executed locally.

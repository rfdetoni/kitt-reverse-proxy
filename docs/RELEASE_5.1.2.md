# Reverse Proxy 5.1.2 — Interrupted FINAL recovery

On 2026-10-09 a Gemini Web response contained an unfinished `KITT/1 ACTION FINAL` followed by a complete restarted FINAL with conflicting fields. The proxy correctly rejected the combined text but left planning interrupted with `agent_contract_invalid`.

The proxy now discards the ambiguous response and requests **one independent FINAL generation from the original task**, without presenting the rejected candidate for repair. The second response passes full KAP, schema and host validation. This behavior is narrowly scoped to an unfinished FINAL prefix and one complete restarted FINAL.

Competing tool actions, duplicate field assignments, multiple complete actions, and other ambiguities still fail closed. The existing attempt budget is respected. The response contract is still v4; there is no Agent CLI or kitt-protocol schema change.

Regression coverage: `test/agent-contract-recovery.test.ts` verifies fresh generation, failed generation and budget exhaustion. Validate with `npm ci --no-audit --no-fund --strict-allow-scripts && npm run verify`, then the CI browser tests.

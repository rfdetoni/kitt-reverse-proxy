# Reverse Proxy 5.4.11 — strict completion integrity

- `src/runtime/agent-contract-validation.ts` now owns the stateless Agent response schema, JSON parsing rules, and tool input validation. `agent-contract.ts` retains the public exports and session-dependent orchestration.
- Bare `{}`, empty final objects, and blank final text cannot be accepted as successful agent completions.
- Model repairs cannot replace a complete, parsed tool_input when an error points only at the broad `$/tool_input` or `$/tool_input/arguments` scope; precise leaf fixes remain supported. Repair does not grant host tools or authorization.
- Lockfile version updated without dependency churn. Existing regression tests remain in place; two cases cover the high-risk false success/host-action rewrite boundary.
- Validation: `npm ci && npm run verify`. Re-check authenticated Gemini Web behavior separately before making performance claims.

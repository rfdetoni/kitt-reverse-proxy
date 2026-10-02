# Reverse Proxy 4.9.3 — canonical Agent contract

## Scope

This patch consolidates the Agent CLI ↔ Reverse Proxy boundary without introducing a new protocol generation. KITT Protocol 0.9.0 remains the shared authority for typed context and request metadata.

## Contract

- Request tools use OpenAI `tools/tool_choice`; legacy `functions/function_call` stays rejected.
- Request context uses typed `kitt_context` and `kitt_meta`.
- WebChat Agent output must be exactly one agent-contract v2 JSON object with all six top-level fields present.
- A single outer `\`\`\`json` fence is accepted only as transport presentation tolerance.
- Semantic aliases and heuristic recovery are removed: no bare runtime object, `<kitt-tool>`, `tool_name/arguments`, malformed write-file reconstruction, or plain-text completion fallback.
- Invalid output uses the existing bounded regeneration path. Exhausted repair remains a recoverable `agent_contract_invalid` error so the Agent can continue/retry in the same session.

## Validation target

`npm run verify` plus the canonical-contract regression in `test/agent-contract.test.ts`.

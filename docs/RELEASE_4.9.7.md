# Reverse Proxy 4.9.7 — WebChat Agent contract recovery

## Scope

Fix repeated `agent_contract_invalid` failures seen with `gemini-web` when the model produced a valid Agent action wrapped by WebChat transport artifacts such as a standalone `JSON` label, or when repair turns replayed too much original task/context and drifted into a fresh answer instead of repairing serialization.

## Changes

- Keep agent-contract v2 strict and fail-closed for prose or ambiguous mixed output.
- Accept only deterministic transport wrappers: bare JSON, one fenced JSON/plain code block containing only the object, or a standalone `JSON` label followed by the object.
- Prefer bare JSON in the system contract and remove the contradictory requirement that every textual file write be fenced.
- Keep repair prompts bounded to route, available tool schemas and the invalid candidate; do not replay the original task or typed workspace context.
- In repair turns, instruct the model to preserve the candidate action and change only the reported contract/serialization violation.
- Add focused regression coverage for the observed WebChat wrapper and compact-repair behavior.

## Validation

Run `npm run verify`. CI additionally validates the fast build, installer syntax, production dependency audits and package contents.

No Agent CLI or KITT Protocol wire change is required. Compatible baseline remains Agent CLI **0.83.15** and KITT Protocol **0.9.0**.

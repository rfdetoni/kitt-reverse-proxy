# Reverse Proxy 4.9.4 — transport-only Agent boundary

## Scope

This release removes duplicate execution policy from the Reverse Proxy after the canonical structural Agent boundary landed. The Agent remains authoritative for tools, workspace execution, approvals, policy, verification and completion. The Proxy remains responsible for provider/browser/session transport.

## Changes

- Keep one canonical agent-contract v2 response shape and strict tool-input schema validation.
- Preserve structural `tools`, `kitt_context`, `kitt_meta`, route and request/session correlation.
- Preserve native `tool_calls` conversion and same-session bounded contract repair.
- Stop filtering tools or runtime operations by route inside the Proxy.
- Stop interpreting `host_execution`, mutation/discovery/validation state or loop checkpoints inside the Proxy.
- Stop blocking completion based on host-policy facts; the Agent host owns those decisions.
- Reuse existing correlation logs and session/capacity health state; no new tracing/lifecycle framework.

## Validation

Run `npm run verify`. Release CI additionally validates the production build, fast-build output, installer syntax, dependency audit and package contents.

Compatible baseline: Agent CLI 0.83.8 and KITT Protocol 0.9.0.

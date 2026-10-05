# Reverse Proxy 4.9.5 — baseline browser pressure admission

## Scope

Fix the first-request failure observed with headed Gemini Web sessions:

`session_limit_exceeded: Limite de sessões simultâneas atingido.`

The failure could occur immediately after startup even with `maxSessions > 1` because the base Chromium process tree already exceeded the configured RSS budget before any named Agent session existed. Session count and resource pressure were collapsed into the same admission failure.

## Changes

- Keep the configured session-count limit strict.
- Keep active/protected named sessions non-evictable.
- Under resource pressure, recycle an idle named session when one exists.
- If only the default browser baseline exists, admit exactly one named session so the proxy remains usable.
- While that named session is busy/protected, a second named admission under pressure still fails closed.
- Emit `session.capacity.baseline_pressure_admission` with RSS/page capacity diagnostics when this bootstrap exception is used.

## Validation

- Updated `test/session-manager.test.ts` to force resource pressure, prove the first named session is admitted, and prove a second session is rejected while the first remains active.
- Full CI/release validation remains unchanged.

No Agent contract or KITT Protocol schema change is required.

# Tool bridge review — 2026-09-08

The browser receives a text protocol: print tool calls in the visible assistant
reply, then wait for results from the external agent. The proxy validates those
calls and translates them to API-native calls. Website-internal tools, hidden
reasoning and canvas artifacts do not substitute for host execution.

## Corrected findings

| Severity / confidence | Location | Problem and impact | Fix and validation |
| --- | --- | --- | --- |
| High / high | `src/runtime/tool-response.ts` | Canvas content could synthesize writes with a guessed filename, including `index.html`. | Removed synthesized writes; regression proves artifacts cannot request host writes. |
| High / high | `src/runtime/tool-enforcement.ts` | Compact `kitt_runtime` and namespaced shell tools could bypass meaningful explore-first classification. | Classify runtime operations and shell commands; reject mixed exploration/mutation batches before evidence. Regression coverage includes dangerous shell options. |
| Medium / high | `src/runtime/ui-executor.ts` | Tool-only continuations could reset conversation evidence; supplied names could bypass unknown call IDs; cache ignored changed request options. | Preserve tool-turn task state, validate known ID/name pairs, cache the complete request. HTTP integration exercises Responses tool-result continuation. |
| Medium / high | `src/proxy/anthropic.ts` | Streaming could repeat text and start the same content block repeatedly; parallel restrictions were lost. | Emit only missing text suffixes, start once, preserve parallel restriction; exact event assertions. |
| Medium / high | `src/runtime/session-manager.ts` | Concurrent creations could exceed the session limit. | Count pending creations before awaiting the factory; concurrent-factory regression. |
| Medium / high | `src/mapping/tool-calling.ts` | Tool names were silently truncated; malformed batches could be partially accepted. | Reject invalid identities/batches, preserve ordinary JSON answers; parser regressions. |

The proxy still does not execute host tools. Host approvals, path containment and
process policy remain the executing agent's responsibility. Shell classification
is an exploration heuristic, not a shell sandbox. No dependencies were added.
Existing protocol/request limits remain; request caching stores one bounded
request per session. This review does not establish that all session lifecycle
or provider-specific behaviors are defect-free.

## Validation

- 137 Node tests pass; TypeScript check and production build pass.
- Actual headless Chromium fixture: real DOM input/output, real HTTP/SSE server,
  installed KITT Python adapter, host README read, tool-result continuation and
  final response. The first premature answer is rejected and reprompted.
- Installed `kitt-reverse-proxy` is linked to this checkout; production build
  updates it. Installed command help succeeds outside the workspace.
- No authenticated live ChatGPT/Claude/Gemini session or Windows/macOS run was
  exercised. Prompt compliance cannot be guaranteed; malformed calls and
  premature answers are rejected/retried within the existing retry limits.

Workspace review inventoried eight repositories (741 tracked files), inspected
architecture/contracts and tested the supporting components. Detailed source
review concentrated on the CLI/proxy paths; this was not a line-by-line audit of
all 741 files.

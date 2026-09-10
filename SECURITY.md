# Security Model — K.I.T.T. Reverse Proxy v3

## Intended use

Use the proxy only with chats, accounts, sessions and endpoints you are authorized to automate.

The project does **not** implement CAPTCHA solving, stealth/fingerprint evasion, WAF or anti-bot bypass, authentication bypass, credential harvesting, or removal of provider rate limits and abuse controls. The CLI explicitly rejects `--stealth`, `--captcha-solver` and `--bypass`.

## Trust boundaries

The main boundaries are:

1. local API/MCP clients;
2. the proxy process and its in-memory session state;
3. Playwright browser contexts that may contain authenticated provider state;
4. provider websites/upstream endpoints;
5. generated model output and tool-call text.

Model output is treated as data. The reverse proxy does not execute generated code. Client-side agents remain responsible for authorizing and executing tool calls.

## Local HTTP API

The server listens on `127.0.0.1` by default. A non-loopback bind requires `--api-key` or `PROXY_API_KEY`.

Authentication is evaluated **before** JSON body parsing. API-key comparison hashes both values with SHA-256 and uses `timingSafeEqual` over constant-length buffers.

CORS is opt-in and accepts only loopback browser origins (`localhost`, `127.0.0.1`, `::1`). CLI clients do not depend on CORS.

`/healthz` is a minimal liveness endpoint. Operational/runtime state is exposed through readiness and KITT management endpoints rather than the public liveness response.

Request lifecycle cancellation is propagated into session queues and executors so a disconnected client does not leave queued work active indefinitely.

## MCP HTTP boundary

Streamable HTTP MCP binds only to loopback. The gateway constructs its internal origin from the configured local listener rather than trusting the incoming `Host` header. Absolute request targets are rejected and only `/mcp` is routed to the MCP handler.

MCP bodies are bounded both by declared `Content-Length` and by bytes actually read. Oversized requests fail before concatenating an unbounded body. Response writes respect Node stream backpressure.

## Providers: UI-first

ChatGPT, Claude, Gemini, Kimi and DeepSeek use UI transport by default. The browser follows the provider's normal authenticated UI instead of the proxy reproducing private mechanisms such as ephemeral signatures, proof-of-work, internal RPC IDs or anti-abuse challenges.

UI automation remains automation and may be subject to provider terms and controls.

## CAPTCHA, anti-bot and login

`security/challenge.ts` detects common signals for CAPTCHA, Cloudflare/security challenges, human verification and login/authentication requirements.

In headed mode, the proxy can wait for manual intervention and resume only when the normal chat input becomes available. In headless mode, a challenge requiring interaction produces a manual-intervention error. The project does not attempt to solve or bypass it.

## Persistent browser sessions

Persistent browser profiles can contain cookies, tokens, localStorage and other authenticated state. Treat the profile directory as credential material:

- keep it outside the repository;
- never commit or publish it;
- restrict filesystem permissions; POSIX profile directories are set to `0700` when possible;
- prefer separate directories per account/provider;
- remove profiles that are no longer required.

A browser supplied through `--cdp-url` is user-owned; shutdown does not intentionally terminate it.

## Network transport and captured session material

A BrowserContext may contain cookies, authorization and CSRF/XSRF state.

- `cookie`, `host`, `content-length` and hop-by-hop headers are not captured/replayed manually;
- cookies come from the BrowserContext request layer;
- profiles do not store captured request headers or the full request base;
- examples sent to a local Ollama mapping model are redacted;
- upstream error bodies are not forwarded verbatim to API clients;
- saved profiles use `0600` where supported.

Network redirects are disabled by default. `--follow-redirects` is opt-in and follows at most five redirects, only within the original origin. Cross-origin redirects are rejected.

Discovery accepts the page host and its subdomains. Other authorized backend hosts require explicit `--allow-endpoint-host` configuration. The implementation intentionally does not infer eTLD+1 trust without a Public Suffix List.

## Resource exhaustion controls

A single shared resource-budget module defines hard bounds for HTTP/MCP input, discovery input/output and candidate count, upstream responses, gateway JSON, UI prompts/history/deltas, telemetry series and structured-log traversal.

Additional controls include:

- bounded serial queues and session counts;
- idle session eviction;
- request, header, keep-alive, discovery, upstream, UI and manual-intervention timeouts;
- bounded tool protocol/arguments/results;
- bounded profile/path/frame parsing;
- response-size verification after read even when `Content-Length` is absent or incorrect;
- bounded/redacted logging and bounded telemetry label cardinality.

These controls are defense-in-depth and do not replace OS/container resource limits for hostile multi-tenant deployment. The intended deployment remains local/single-user.

## Tool calling and tool enforcement

UI providers expose tool calling through a protocol bridge rather than a private provider tool API. Tool execution remains client-side.

Known `kitt_runtime` operations are explicitly classified as exploration, mutation, neutral or mixed operations. This avoids treating all non-read operations as equivalent and gives read-before-write enforcement deterministic semantics. Mixed shell/process operations are classified from the command payload with conservative write/control detection.

Unknown operations are not silently treated as trusted exploration. Request and model tool-protocol failures use structured semantic error codes consumed by K.I.T.T. Agent CLI.

## JSON paths and prototype pollution

The path interpreter rejects dangerous path segments including `__proto__`, `prototype` and `constructor`, including quoted-key forms. Write targets do not accept wildcard paths.

## Structured output, logging and telemetry

Structured-output validation is best-effort and explicitly reported when it fails rather than pretending strict provider-native schema enforcement.

Structured logs redact sensitive keys/values and cap depth, object keys and array elements. User-provided structured fields cannot replace the sanitized top-level log message. URLs written to logs have query strings/fragments removed where applicable.

Metrics use bounded label values and stable route labels rather than raw high-cardinality request paths, session IDs or arbitrary tool/function names.

## Dependency and release integrity

CI runs verification on Node 24 across Linux, Windows and macOS, and Node 26 on Linux. GitHub Actions are pinned to immutable commit SHAs.

The supply-chain job audits production dependencies at moderate severity and above, rejects any high/critical dependency vulnerability in the full dependency tree, and checks the npm package payload with `npm pack --dry-run`.

Dependabot tracks npm and GitHub Actions updates. Tagged releases rerun verification and the production audit, verify that the Git tag matches `package.json`, create an npm-compatible archive and publish SHA-256 checksums with the GitHub release.

## Reporting vulnerabilities

Do not include cookies, tokens, browser profiles, complete authenticated request dumps or other credentials in a report. Provide the smallest sanitized reproduction, affected version/commit and steps required to reproduce the issue.

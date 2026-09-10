# K.I.T.T. Reverse Proxy

Local, loopback-first gateway that exposes authorized web-chat sessions through OpenAI-compatible, Responses, Anthropic, Ollama and MCP interfaces. Its primary compatibility target is **K.I.T.T. Agent CLI**.

The implementation favors bounded resource usage, cancellation, deterministic protocol behavior and small browser/runtime overhead over internal backward compatibility.

## Runtime support

- Node.js **24+**.
- CI verifies Node 24 on Linux, Windows and macOS, plus Node 26 on Linux.
- Browser automation uses Playwright with an installed Chrome/Chromium when possible; bundled Chromium is a fallback.

## Design

- **One authenticated browser, multiple conversations.** Named `X-Kitt-Session-Id` conversations use independent tabs inside a persistent authenticated context instead of one Chromium process per conversation.
- **Bounded resources.** HTTP/MCP bodies, discovery candidates, upstream responses, UI history, streamed deltas, queues, sessions, telemetry cardinality and structured logs all have explicit limits.
- **Cancellation propagation.** Client disconnects flow through the HTTP lifecycle, session queue and executor so abandoned requests do not keep consuming queue/runtime capacity.
- **Stable KITT protocol.** `X-Kitt-Session-Id` is conversation-stable, `X-Kitt-Request-Id` is request-unique and `X-Kitt-Reasoning-Effort` controls provider reasoning when supported.
- **Progressive UI streaming without cumulative buffering.** The UI transport emits safe suffix deltas and avoids retaining every cumulative DOM snapshot.
- **Explicit tool policy.** Known KITT runtime operations are classified as exploration, mutation, neutral or mixed operations. Generic tools use conservative fallback classification.
- **No chain-of-thought extraction.** Reasoning controls provider mode/effort; private reasoning is not exposed.

## Install / update

### Linux / macOS

```bash
curl -fsSL https://raw.githubusercontent.com/rfdetoni/kitt-reverse-proxy/main/install.sh | bash
```

### Windows PowerShell

```powershell
irm https://raw.githubusercontent.com/rfdetoni/kitt-reverse-proxy/main/install.ps1 | iex
```

Requirements: Git, Node.js 24+ and npm. The bootstrap installer comes from `main`, but the installed source defaults to the newest immutable `vMAJOR.MINOR.PATCH` release tag. Re-running the command upgrades to the latest stable release. Pass `--ref main` to the downloaded installer, or set `KITT_PROXY_REF=main`, only when you intentionally want unreleased code. Browser policy is `auto` by default; `system` and `bundled` are also available.

## Start

```bash
kitt-reverse-proxy start chatgpt
kitt-reverse-proxy start claude
kitt-reverse-proxy start gemini
```

Useful modes:

```bash
kitt-reverse-proxy start chatgpt --headless
kitt-reverse-proxy start chatgpt --headed
kitt-reverse-proxy start chatgpt --cdp-url http://127.0.0.1:9222
kitt-reverse-proxy presets
```

`auto` browser mode probes the stored profile headlessly first. If login/intervention is required, KITT opens a visible browser, persists the authenticated profile, closes it and retries headless.

## K.I.T.T. Agent CLI contract

The proxy exposes:

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`
- `POST /api/chat`
- `GET /v1/models`
- `GET /v1/capabilities`
- `GET /v1/kitt/status`
- `GET /v1/kitt/sessions`
- `POST /v1/kitt/reset`
- `DELETE /v1/kitt/sessions/:id`
- `GET /v1/kitt/metrics`
- `GET /healthz` — process liveness only
- `GET /readyz` — runtime readiness

KITT-specific headers:

```text
X-Kitt-Session-Id: stable conversation id
X-Kitt-Request-Id: unique request id
X-Kitt-Reasoning-Effort: 0..100 when supported
```

`GET /v1/capabilities` publishes the live `kitt_agent_cli` contract, including session capacity and reasoning support. Chat Completions streaming uses standard SSE and terminates with `[DONE]`. Native tool calls are reconstructed for the Agent CLI round trip; `parallel_tool_calls=false` remains the recommended KITT path.

## MCP

Run stdio MCP:

```bash
kitt-reverse-proxy mcp chatgpt
```

Or loopback Streamable HTTP:

```bash
kitt-reverse-proxy mcp --mcp-port 3100 chatgpt
```

The HTTP MCP boundary accepts only the local `/mcp` target, has bounded request bodies and does not trust the incoming `Host` header to select an internal origin.

## Authentication and network exposure

The HTTP API binds to loopback by default. If you intentionally bind to a non-loopback interface, configure `--api-key` or `PROXY_API_KEY`. Authentication is checked before JSON parsing, reducing unauthenticated parser/resource exposure.

CORS is opt-in and restricted to browser loopback origins. CLI clients do not require CORS.

## Browser ownership

A browser supplied with `--cdp-url` is user-owned. KITT attaches to it but does not intentionally terminate it during proxy shutdown. Persistent KITT profiles live under `~/.kitt-reverse-proxy/<provider>` by default and should be treated as credentials.

For minimum RAM, prefer system Chrome/Chromium with the default persistent-profile mode, or attach an already-running browser with CDP. Named UI sessions share the authenticated browser process.

## Security and supply chain

The project does not bypass CAPTCHA, authentication, WAF or provider security controls. Manual challenges remain manual. Requests, responses, logs and telemetry are bounded/redacted where appropriate.

Direct dependencies are pinned to the exact versions exercised by CI; Dependabot is the explicit update path. CI pins GitHub Actions by commit SHA, runs cross-platform verification, audits dependencies, enforces reviewed install scripts and validates package contents. Tagged releases rerun verification and production audit, publish an npm-compatible tarball plus SHA-256 checksums and a CycloneDX SBOM, and attach GitHub/Sigstore SLSA provenance and SBOM attestations.

See `SECURITY.md` for the detailed security model.

## Development

```bash
npm ci --strict-allow-scripts
npm run verify
```

The implementation remains TypeScript/Node.js because the dominant workload is asynchronous HTTP/browser orchestration and Playwright is the native browser-control layer. This is an implementation choice rather than a compatibility promise; internals may change when a materially simpler or more efficient design is available.

## License

MIT. See `LICENSE`.

# K.I.T.T. Reverse Proxy

<p align="center">
  <strong>Local-first AI gateway for authorized web-chat sessions.</strong><br>
  OpenAI · Responses · Anthropic · Ollama · MCP · provider discovery · resilient browser sessions
</p>

<p align="center">
  <a href="https://github.com/rfdetoni/kitt-reverse-proxy/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/rfdetoni/kitt-reverse-proxy/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/rfdetoni/kitt-reverse-proxy/blob/main/LICENSE"><img alt="License MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Node 24+" src="https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-Node.js-3178C6?logo=typescript&logoColor=white">
</p>

K.I.T.T. Reverse Proxy exposes authenticated web-chat sessions through stable local APIs designed for coding agents and the broader K.I.T.T. ecosystem. It favors bounded resources, cancellation, deterministic protocol behavior, secure browser ownership and low overhead over reproducing private provider internals.

The primary compatibility target is **K.I.T.T. Agent CLI**, while the API surface is intentionally usable by OpenAI-, Anthropic-, Ollama- and MCP-compatible clients.

---

## What’s included

- OpenAI-compatible `Chat Completions` and `Responses` APIs.
- Anthropic-compatible `Messages` API.
- Ollama-compatible chat/generate endpoints.
- MCP server over stdio or loopback Streamable HTTP.
- Authenticated browser profiles with one browser and multiple isolated conversations.
- UI and network transports with safe automatic bootstrap fallback for generic chats.
- Provider/model registry with capability discovery endpoints.
- Per-session circuit breaker with half-open recovery and latency EWMA.
- Progressive UI streaming without retaining cumulative DOM snapshots.
- Native tool-call reconstruction and K.I.T.T. tool-enforcement semantics.
- Bounded Prometheus/JSON telemetry, queues, sessions, request bodies and upstream responses.
- Agent gateway helpers for Codex, Claude, OpenCode, Ollama and JetBrains ACP workflows.

---

## Quick links

- **K.I.T.T. ecosystem:** https://github.com/rfdetoni/kitt
- **Agent CLI:** https://github.com/rfdetoni/kitt-agent-cli
- **Security model:** [SECURITY.md](SECURITY.md)
- **Provider discovery:** `GET /v1/providers`
- **Runtime capabilities:** `GET /v1/capabilities`
- **Metrics:** `GET /v1/kitt/metrics`

---

## Requirements & compatibility

- Node.js **24+**.
- Git and npm for source installation.
- Chrome/Chromium for browser automation; Playwright Chromium is a fallback.
- Linux, Windows and macOS are verified by CI on Node 24; Linux is additionally verified on Node 26.

The default API listener is loopback-only. Persistent browser profiles should be treated as credential material.

---

## Installation

### Linux / macOS

```bash
curl -fsSL https://raw.githubusercontent.com/rfdetoni/kitt-reverse-proxy/main/install.sh | bash
```

### Windows PowerShell

```powershell
irm https://raw.githubusercontent.com/rfdetoni/kitt-reverse-proxy/main/install.ps1 | iex
```

The bootstrap installer comes from `main`, while installed source defaults to the newest immutable `vMAJOR.MINOR.PATCH` release. Re-running the installer upgrades to the latest stable release.

Use `--ref main` or `KITT_PROXY_REF=main` only when you intentionally want unreleased code.

---

## Docker

Docker support is optional. The repository provides two reverse-proxy image targets plus a dedicated Chromium sidecar:

- `runtime`: Node/Playwright client runtime without a bundled browser, intended to connect to a browser sidecar over CDP;
- `standalone` (the default final target): includes Playwright Chromium for a self-contained headless container;
- `docker/browser.Dockerfile`: isolated Chromium sidecar with a persistent profile, headless normal mode and optional noVNC UI for manual authentication.

### Standalone headless container

```bash
docker build -t kitt-reverse-proxy .
docker run --rm \
  --shm-size=1g \
  -p 127.0.0.1:3000:3000 \
  -e PROXY_API_KEY="$(openssl rand -hex 32)" \
  -v kitt-browser-profile:/data/browser \
  kitt-reverse-proxy
```

The container listens on `0.0.0.0` internally so other containers can reach it, therefore `PROXY_API_KEY` is mandatory. Publishing the port on host loopback keeps the API local to the machine.

### Browser sidecar

The ecosystem Compose file in [`rfdetoni/kitt`](https://github.com/rfdetoni/kitt) uses the lighter `runtime` target and connects it to the dedicated browser container through `CDP_URL=http://browser:9222`. The CDP port is deliberately **not** published to the host.

For normal operation the sidecar runs Chromium headlessly. If the provider requires login, CAPTCHA or another manual challenge, switch the browser to headed mode and use the noVNC UI on host loopback:

```bash
KITT_BROWSER_MODE=headed docker compose up -d browser reverse-proxy
```

Then open `http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=remote`, complete the authentication manually, set `KITT_BROWSER_MODE=headless` again and restart the browser service. The same `/data/browser` volume is reused, so the authenticated profile survives container restarts.

Treat that browser-profile volume as credential material. Do not publish port `9222`, and do not expose the noVNC port beyond trusted host loopback.

---

## Running the proxy

Start one of the built-in web providers:

```bash
kitt-reverse-proxy start chatgpt
kitt-reverse-proxy start claude
kitt-reverse-proxy start gemini
kitt-reverse-proxy start kimi
kitt-reverse-proxy start deepseek
```

Useful browser modes:

```bash
kitt-reverse-proxy start chatgpt --headless
kitt-reverse-proxy start chatgpt --headed
kitt-reverse-proxy start chatgpt --cdp-url http://127.0.0.1:9222
kitt-reverse-proxy presets
```

`auto` browser mode probes the stored profile headlessly first. If login or manual intervention is required, K.I.T.T. opens a visible browser, persists the authenticated profile, closes it and retries headless.

For a custom web chat:

```bash
kitt-reverse-proxy https://example.com/chat --provider generic --transport auto
```

For generic chats, `auto` tries network discovery first and falls back to the normal UI path if bootstrap discovery cannot be established. The failed request is **not replayed** across transports.

---

## Providers & models

The provider registry is deliberately small and curated rather than quantity-driven.

| Provider | API model | Default transport | UI image input | Reasoning control |
| --- | --- | --- | --- | --- |
| ChatGPT | `chatgpt-web` | UI | Yes | Yes |
| Claude | `claude-web` | UI | Yes | No |
| Gemini | `gemini-web` | UI | Yes | No |
| Kimi | `kimi-web` | UI | No | No |
| DeepSeek | `deepseek-web` | UI | No | No |
| Generic web chat | `adaptive-web-chat` | Network → UI fallback | Depends on target | No |

Discovery endpoints:

```text
GET /v1/providers
GET /v1/providers/:provider
GET /v1/providers/:provider/models
GET /v1/models
GET /v1/capabilities
```

Provider records include supported transports, route-model aliases, static capabilities and live resilience state for the active runtime.

---

## Reliability & performance

K.I.T.T. keeps resilience on the safe side of chat semantics:

- **No automatic replay of dispatched chat POSTs.** A network interruption after dispatch may mean the provider already accepted the prompt, so transparent request retries are intentionally avoided.
- **Circuit breaker per session/transport.** Three consecutive availability failures open the circuit for 30 seconds; the next eligible request becomes a half-open probe.
- **Low-overhead health tracking.** Success/failure counters and an in-memory latency EWMA add constant work per request.
- **Health-aware readiness.** `/readyz` returns `503` while the active provider circuit is open.
- **Bounded queues and sessions.** Named sessions use serial queues, capacity limits and idle LRU eviction.
- **Cancellation propagation.** Client disconnects flow through request lifecycle, queue and executor layers.
- **Progressive streaming.** UI streaming emits suffix deltas instead of buffering every cumulative page snapshot.

Provider resilience events are available in JSON and Prometheus output through `/v1/kitt/metrics` as `provider_events_total`.

---

## API compatibility

The proxy exposes:

```text
POST   /v1/chat/completions
POST   /v1/responses
POST   /v1/messages
POST   /api/chat
POST   /api/generate
GET    /api/tags
GET    /api/version
GET    /api/show
GET    /v1/models
GET    /v1/providers
GET    /v1/providers/:provider
GET    /v1/providers/:provider/models
GET    /v1/capabilities
GET    /v1/kitt/status
GET    /v1/kitt/sessions
POST   /v1/kitt/reset
DELETE /v1/kitt/sessions/:id
GET    /v1/kitt/metrics
GET    /healthz
GET    /readyz
```

K.I.T.T.-specific headers:

```text
X-Kitt-Session-Id: stable conversation id
X-Kitt-Request-Id: unique request id
X-Kitt-Reasoning-Effort: 0..100 when supported
```

Chat Completions streaming uses standard SSE and terminates with `[DONE]`. Native tool calls are reconstructed for the Agent CLI round trip. `parallel_tool_calls=false` remains the recommended K.I.T.T. path.

---

## Sessions

A single authenticated browser can host multiple logical conversations. Named `X-Kitt-Session-Id` values receive independent tabs in the same persistent browser context instead of launching one Chromium process per conversation.

Session behavior includes bounded concurrent capacity, bounded per-session queues, idle LRU eviction, explicit reset/delete endpoints, stable conversation IDs across Agent CLI turns and circuit-breaker state isolated with the session executor.

---

## MCP

Run stdio MCP:

```bash
kitt-reverse-proxy mcp chatgpt
```

Or loopback Streamable HTTP:

```bash
kitt-reverse-proxy mcp --mcp-port 3100 chatgpt
```

The HTTP MCP boundary accepts only the local `/mcp` target, bounds request bodies and never trusts the incoming `Host` header to choose an internal origin.

---

## Agent gateway

K.I.T.T. can prepare local-only environments for coding agents without leaking direct provider endpoints:

```bash
kitt-reverse-proxy gateway verify
kitt-reverse-proxy gateway env openai
kitt-reverse-proxy gateway agent codex
kitt-reverse-proxy gateway agent claude
kitt-reverse-proxy gateway agent opencode
```

JetBrains ACP entries can also be generated through the gateway CLI.

---

## Authentication & network exposure

The HTTP API binds to `127.0.0.1` by default. Binding to a non-loopback interface requires `--api-key` or `PROXY_API_KEY`.

Authentication is checked **before** JSON parsing, reducing unauthenticated parser and memory exposure. CORS is opt-in and restricted to loopback browser origins.

A browser supplied with `--cdp-url` is user-owned. K.I.T.T. attaches to it but does not intentionally terminate it during proxy shutdown.

---

## Security model

The project does **not** bypass CAPTCHA, authentication, WAFs, anti-bot systems or provider security controls. Manual challenges remain manual.

Security controls include loopback-first listeners, constant-length API-key comparison, bounded request/response bodies and telemetry cardinality, sanitized/redacted structured logging, same-origin-only optional network redirects, endpoint-host allowlisting, persistent profile permission hardening, prototype-pollution-safe JSON paths, client-side tool execution and explicit tool policy, and pinned dependency/release supply-chain checks.

See [SECURITY.md](SECURITY.md) for the full trust-boundary model.

---

## Configuration

Common options:

```text
--provider <id>              auto|generic|chatgpt|claude|gemini|kimi|deepseek
--transport <mode>           auto|ui|network
--api-model <id>             model ID exposed through the API
--user-data-dir <dir>        persistent Chromium profile
--cdp-url <url>              attach to an existing browser
--max-sessions <n>           maximum live sessions
--max-queue <n>              bounded queue depth
--session-idle-timeout <s>   idle session eviction timeout
--tool-enforcement <mode>    auto|explore-first|required
--allow-endpoint-host <host> authorize an additional network-discovery backend
--headless | --headed | --auto-browser
```

Run `kitt-reverse-proxy --help` for the complete list.

---

## Development

Install and run the complete verification suite:

```bash
npm ci --strict-allow-scripts
npm run verify
```

The project remains TypeScript/Node.js because the dominant workload is asynchronous HTTP/browser orchestration and Playwright is the native browser-control layer.

CI validates Node 24 on Linux, Windows and macOS plus Node 26 on Linux. Production dependency audits, package-content checks and installer syntax validation run alongside tests and builds.

---

## Contributing

Keep changes focused on deterministic gateway behavior, bounded resource use, provider compatibility and agent-facing protocol quality. New provider support should include capability metadata, tests and a clear security model rather than relying on runtime-downloaded provider code.

When borrowing ideas from external projects, preserve license boundaries. K.I.T.T. is MIT and does not copy GPL-licensed provider implementations into this repository.

---

## K.I.T.T. ecosystem

| Repository | Responsibility |
| --- | --- |
| [`kitt`](https://github.com/rfdetoni/kitt) | ecosystem installer and composition |
| [`kitt-agent-cli`](https://github.com/rfdetoni/kitt-agent-cli) | autonomous coding-agent control plane |
| [`kitt-reverse-proxy`](https://github.com/rfdetoni/kitt-reverse-proxy) | authorized web-chat/API gateway |
| [`kitt-protocol`](https://github.com/rfdetoni/kitt-protocol) | shared cross-language contracts |
| [`kitt-memory`](https://github.com/rfdetoni/kitt-memory) | persistent local memory engine |
| [`kitt-toolbox`](https://github.com/rfdetoni/kitt-toolbox) | native code/system data plane |
| [`kitt-ai-workers`](https://github.com/rfdetoni/kitt-ai-workers) | isolated AI/ML workers and evals |
| [`kitt-assistant`](https://github.com/rfdetoni/kitt-assistant) | resident assistant and Control Center |

---

## License

MIT. See [LICENSE](LICENSE).
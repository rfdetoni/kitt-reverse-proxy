## Reverse Proxy 4.7.5 — persistent bounded-loop checkpoints and compact recovery

Reverse Proxy 4.7.5 fixes the agent-loop action budget so checkpoints are scoped to a bounded loop rather than inferred from global tool-call multiples. Checkpoint tool responses are now marked structurally, allowing the next host result to start a new loop epoch with `LOOP_ACTION_COUNT=1` instead of incorrectly clearing/retriggering checkpoints based on `HOST_ROUND_TRIP_COUNT % budget`.

The orchestrator now exposes `LOOP_INDEX`, `LOOP_ACTION_COUNT`, `LOOP_ACTION_BUDGET` and `TURN_TOOL_CALL_COUNT` while retaining the total host round-trip counter for diagnostics. Contract-failure bootstrap reinjection also uses a bounded recent-validation window and cooldown, preventing a small number of early malformed responses from forcing repeated full-context bootstrap requests.

This release pairs with Agent CLI **0.81.1**.

## Reverse Proxy 4.7.4 — protocol-owned request metadata and immutable releases

Reverse Proxy 4.7.4 keeps the shared Protocol `KittRequestMetadata` wire shape for `kitt_meta`, including optional session identity. K.I.T.T. execution context remains accepted through typed `kitt_context` only, tools come from the native `tools` schema only, and route/correlation metadata stays outside provider-visible logical history. Legacy `[KITT TURN CONTEXT]` and textual `Tool Contract:` parsing remain removed.

`conversation_id`, `turn_id` and the unified request ID are logged as structured correlation metadata and are stripped before provider-visible logical history. Typed context likewise remains outside WebChat history, preserving the browser conversation while retry/continue flows reuse the same execution metadata and usage accounting.

Release automation now treats semantic tags as immutable: if the current package version already matches the latest release, the validated SHA must be exactly the SHA behind that tag. Unpublished commits at an already released version fail fast and require a new version bump instead of retagging or silently skipping the release.

The agent-contract regression suite uses structural fixtures for discovery-first execution, mutation/validation gating, bounded-loop checkpoints, summarize isolation and repair continuity. This release pairs with Agent CLI **0.80.5**, Protocol **0.5.2** and Memory **0.6.1**.

## Reverse Proxy 4.7.0 — LLM-first agent-contract v2

Reverse Proxy 4.7.0 introduces the internal **agent-contract v2** and the language-neutral `agent-loop` used by Agent CLI 0.79.0. The original user request remains verbatim and WebChat is the only component that interprets its natural language, scope and intent; the proxy no longer strengthens routes from Portuguese/English keywords or project-domain heuristics.

Each agent-loop response carries a bounded loop state with `objective`, `completion_criteria`, `status` and `validation_summary`. The proxy counts completed host round trips and requires a model checkpoint every configured action budget (default **4**) before another slice continues. Checkpoints are evidence-driven: they are based on actual host observations, not model claims.

Safety remains deterministic. The first mutation cannot occur before repository evidence, tools remain allowlisted and schema-validated, policy/approvals stay host-side, and any mutation requires a successful build/test/check after the latest write before `final_response` when validation is available. Contract v1 compatibility is intentionally not retained; Reverse Proxy 4.7.0 is paired with Agent CLI 0.79.0.

## Reverse Proxy 4.6.8 — WebChat conversation hydration

Fresh browser-backed WebChat sessions now receive the prior caller-visible API conversation exactly once before the current actionable turn. Existing stateful browser sessions continue with delta-only prompts, preventing both lost conversational context and repeated-history superprompt growth.

System/developer instructions remain on the dedicated protocol path rather than being replayed as simulated chat messages, and the current user/tool turn is excluded from the hydration envelope to avoid duplication.

## Reverse Proxy 4.6.7 — validation evidence gate

Agent mutation turns now carry validation state explicitly. A final response is rejected until a host build/test/check reports `HOST_STATUS: success` after the latest mutation; failed validation resets completion eligibility instead of allowing the model to claim that the project was tested successfully.

## Reverse Proxy 4.6.6 — recoverable model-response failures

Reverse Proxy 4.6.6 keeps browser-backed Agent sessions alive when the upstream model repeatedly returns an invalid Agent contract. After the built-in repair attempts are exhausted, the proxy returns a structured recoverable `agent_contract_invalid` response with `recovery_action: "continue"` instead of misclassifying the event as a terminal `502/api_error`.

The named `X-Kitt-Session-Id` session is preserved so Agent CLI can offer **Continue / Retry** without reconnecting or replaying already completed host tools. Non-recoverable network, browser and protocol failures keep their normal error semantics.

## Reverse Proxy 4.6.5 — synthetic tool-call continuity

Reverse Proxy 4.6.5 preserves Agent contract tool round trips when an OpenAI-style assistant message contains both a native `tool_calls` entry and public progress text in `content`. Contract-generated call IDs are normalized back into KITT tool-result evidence before the browser executor sees the next turn, preventing false `invalid_tool_request: unknown tool_call_id` failures.

Reverse Proxy 4.6.4 prevents superprompt amplification in browser-backed Agent sessions. Generated Agent persona and the textual Tool Contract are no longer re-forwarded after the proxy has received the real tool schema structurally.

Mutation turns use a compact deterministic execution plan: `discovery -> mutation -> validation`. Only one host action is requested for the current phase before waiting for its result. Trusted orchestration retained from the Agent is capped at 4 KiB, while workspace/tool schemas are sent only when the session bootstrap changes; later turns remain deltas.

Contract repair remains isolated from the workspace bootstrap. Valid Gemini-style `use_tool` responses that omit nullable `content` or `reasoning_summary` are normalized locally instead of causing repair loops.

## Reverse Proxy 4.6.3 — staged agent contract

Reverse Proxy 4.6.3 removes the superprompt regression in browser-backed agent execution. The first request for a stable Agent session is a bounded bootstrap with the active tool schema and workspace evidence; later tool round trips use compact delta context and rely on the named session for already-supplied bootstrap state.

Contract repair no longer resends the original workspace/task payload. Valid `use_tool` responses may omit nullable `content`/`reasoning_summary`, and common `tool_name`/`arguments` aliases are normalized locally before schema validation. Broad implementation turns preserve the Agent's structured discovery phase, forcing one repository observation before mutation and then progressing one host action per round trip.

## Reverse Proxy 4.6.1 — reasoning-summary transport

Reverse Proxy 4.6.1 preserves the validated agent-contract `reasoning_summary` on native OpenAI tool-call completions instead of discarding it when `action="use_tool"` is transformed into `tool_calls`. The summary remains bounded by the existing two-sentence / 400-character contract and is public progress metadata, not chain-of-thought.

This allows Agent CLI 0.77.2+ to show what the model is doing and why while keeping the concrete tool/operation as a separate technical detail.

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

Tool-call conversations that are waiting for a client-side tool result (including human approval in KITT Agent CLI) are pinned and are not evicted by session idle timeout until the result or explicit session reset/close arrives.

Agent-contract mutation routes are fail-closed: unstructured status prose is never reinterpreted as a successful final response. A bare `{operation, arguments}` object is normalized only when it unambiguously represents `kitt_runtime`, then still passes the normal tool-availability, route and JSON-schema validation. For WebChat file writes, the contract uses a fenced JSON transport so Markdown/HTML rendering cannot consume XML tags, CSS asterisks or other source characters before the proxy reconstructs the tool call.

Install/update scripts stop resident KITT services before replacing runtime files, preventing an old daemon/proxy process from holding ports, browser sessions or executable files across an upgrade.

## What’s included

- OpenAI-compatible `Chat Completions` and `Responses` APIs.
- Anthropic-compatible `Messages` API.
- Ollama-compatible chat/generate endpoints.
- MCP server over stdio or loopback Streamable HTTP.
- Authenticated browser profiles with one browser and multiple isolated conversations.
- UI and network transports with safe automatic bootstrap fallback for generic chats.
- Versioned provider-plugin SDK and registry with capability discovery endpoints.
- Per-session circuit breaker with half-open recovery and latency EWMA.
- Progressive UI streaming without retaining cumulative DOM snapshots.
- Native tool-call reconstruction and K.I.T.T. tool-enforcement semantics.
- Bounded Prometheus/JSON telemetry, queues, sessions, request bodies and upstream responses.
- Agent gateway helpers for Codex, Claude, OpenCode, Ollama and JetBrains ACP workflows.

---

## Reverse Proxy 4.5.0 — agentic WebChat reliability

Reverse Proxy 4.5.0 aligns browser-backed providers with the Agent CLI 0.77 execution model:

- discovery-first turns expose and validate whether a read-only repository observation has completed before mutation is accepted;
- WebChat response waiting is activity-aware: visible streaming state, response-text changes and DOM mutations refresh the inactivity budget;
- the configured UI response timeout is treated as inactivity protection, while a larger bounded absolute ceiling prevents infinite waits;
- Gemini response extraction keeps the broader selector set introduced in 4.4.2;
- managed browser-service startup retains the 330-second readiness budget for login/profile startup.

This does not make UI automation equivalent to an official streaming API. When a native provider API is configured, its token stream remains the preferred low-latency transport; WebChat remains a resilient compatibility path.

## Architecture v4

Version 4 formalizes the reverse proxy as a **browser-backed AI gateway runtime**, while preserving the OpenAI-compatible contract consumed by K.I.T.T. Agent CLI.

- Default providers are independent plugins under `src/plugins/default/` behind a versioned registry; trusted external plugins can be loaded explicitly without changing the gateway core.
- UI automation uses provider selector packs first, then a bounded semantic locator cascade.
- Named conversations keep serialization per session; a browser session broker owns tab/context allocation and authenticated-context reuse.
- `/v1/capabilities` publishes the machine-readable proxy contract, provider-registry contract, browser controls and observability surface.
- The compatibility contract used by K.I.T.T. Agent CLI remains `POST /v1/chat/completions`, SSE tool calls, `X-Kitt-Session-Id`, `X-Kitt-Request-Id` and `GET /v1/capabilities`.

### Observability and safe diagnostics

Structured logs correlate `request_id`, `session_id`, provider, trace ID and span ID. Log verbosity and payload visibility are deliberately separate:

```bash
kitt-reverse-proxy chatgpt --log-format json --log-level 2 --log-content metadata
```

`--log-content metadata` is the default and records payload shape/size without prompt or response content. `none` omits content-bearing fields. `full` is explicit opt-in and still applies secret/URL redaction.

The built-in metrics endpoint remains available as JSON or Prometheus. OTLP/HTTP JSON tracing is dependency-free and activates only when configured:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
kitt-reverse-proxy chatgpt
```

The proxy propagates W3C `traceparent` and emits child spans for session resolution and transport execution. Telemetry export is bounded and never blocks request execution.

---

## Quick links

- **K.I.T.T. ecosystem:** https://github.com/rfdetoni/kitt
- **Agent CLI:** https://github.com/rfdetoni/kitt-agent-cli
- **GHCR packages:** https://github.com/rfdetoni?tab=packages
- **Security model:** [SECURITY.md](SECURITY.md)
- **Provider discovery:** `GET /v1/providers`
- **Provider plugin SDK:** `kitt-reverse-proxy/plugin-sdk`
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

Docker support is optional. Every semantic release publishes three Linux container images to GitHub Container Registry (GHCR):

| Image | Purpose |
| --- | --- |
| `ghcr.io/rfdetoni/kitt-reverse-proxy` | lightweight `runtime` target for the browser-sidecar topology |
| `ghcr.io/rfdetoni/kitt-reverse-proxy-standalone` | self-contained proxy with Playwright Chromium bundled |
| `ghcr.io/rfdetoni/kitt-reverse-proxy-browser` | isolated Chromium sidecar with persistent profile and optional noVNC |

Each release publishes `vMAJOR.MINOR.PATCH`, `MAJOR.MINOR.PATCH`, `MAJOR.MINOR`, `MAJOR` and `latest` aliases. `latest` tracks the newest stable release; pin the complete release tag or an immutable digest for reproducible deployments. Published images include OCI provenance and SBOM attestations and currently target `linux/amd64`.

GHCR packages index: https://github.com/rfdetoni?tab=packages

GitHub creates the direct page for each container package only after that image is published for the first time. Until then, use the packages index above and these canonical image names:

```text
ghcr.io/rfdetoni/kitt-reverse-proxy
ghcr.io/rfdetoni/kitt-reverse-proxy-standalone
ghcr.io/rfdetoni/kitt-reverse-proxy-browser
```

### Standalone headless container

The simplest deployment uses the bundled-browser image:

```bash
docker pull ghcr.io/rfdetoni/kitt-reverse-proxy-standalone:latest

docker run --rm \
  --shm-size=1g \
  -p 127.0.0.1:3000:3000 \
  -e PROXY_API_KEY="$(openssl rand -hex 32)" \
  -v kitt-browser-profile:/data/browser \
  ghcr.io/rfdetoni/kitt-reverse-proxy-standalone:latest
```

The container listens on `0.0.0.0` internally so other containers can reach it, therefore `PROXY_API_KEY` is mandatory. Publishing the port on host loopback keeps the API local to the machine.

### Browser sidecar

The ecosystem Compose file in [`rfdetoni/kitt`](https://github.com/rfdetoni/kitt) uses the lighter runtime image and connects it to the dedicated browser image through `CDP_URL=http://browser:9222`. The CDP port is deliberately **not** published to the host.

For normal operation the sidecar runs Chromium headlessly. If the provider requires login, CAPTCHA or another manual challenge, switch the browser to headed mode and use the noVNC UI on host loopback:

```bash
KITT_BROWSER_MODE=headed docker compose up -d browser reverse-proxy
```

Then open `http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=remote`, complete the authentication manually, set `KITT_BROWSER_MODE=headless` again and restart the browser service. The same `/data/browser` volume is reused, so the authenticated profile survives container restarts.

Treat that browser-profile volume as credential material. Do not publish port `9222`, and do not expose the noVNC port beyond trusted host loopback.

### Build from source

The Dockerfile keeps both image targets available for development:

```bash
docker build --target runtime -t kitt-reverse-proxy:runtime .
docker build --target standalone -t kitt-reverse-proxy:standalone .
docker build -f docker/browser.Dockerfile -t kitt-browser:dev .
```

The root ecosystem `compose.yaml` contains both official image references and source build definitions. Compose therefore prefers the registry image and can build from source when a referenced image is not yet available. The `compose.dev.yaml` override in `rfdetoni/kitt` gives local development images distinct names.

---

## Running the proxy

Start one of the default WebChat provider plugins:

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

The browser stays visible by default, including after login. Pass `--headless` to run without a window. The optional `--auto-browser` mode probes the stored profile headlessly first; if login is required, it opens a temporary window and then retries headless.

UI transport always reuses a K.I.T.T.-managed persistent browser profile unless `--cdp-url` is supplied. Known providers use `~/.kitt-reverse-proxy/<provider>`; a provider detected from a raw URL resolves to the same directory, so switching between `chatgpt` and `https://chatgpt.com/` no longer creates an ephemeral browser context. Generic sites receive a deterministic origin-isolated profile.

Local Playwright launches enable the Chromium sandbox. The dedicated Docker browser boundary may explicitly disable the browser sandbox because the container supplies the isolation boundary. Do not point `--user-data-dir` at Chrome's normal/default User Data directory; use a dedicated automation profile or attach to an explicitly debug-enabled browser with `--cdp-url`.

### Prompt language policy

All K.I.T.T.-generated system, developer, orchestration, repair, retry, tool-protocol, and validation-feedback prompts sent to upstream models are authored in English. User-authored text is preserved verbatim in its original language, and multilingual intent-detection vocabularies remain multilingual because they are classifier data rather than model instructions.

The agent-contract route guard also recognizes imperative workspace conversion/migration requests (for example, Gradle to Maven) as code-edit work even if an upstream caller initially labels the route as `chat`.

### Gemini / Google Account login

Google may reject sign-in when the browser is already controlled by automation. For Gemini, K.I.T.T. therefore uses a separate human-authentication bootstrap: when the stored Gemini profile is not authenticated, it opens the installed stable Google Chrome with the dedicated K.I.T.T. profile and a loopback-only remote-debugging port, but does **not** attach Playwright during the Google Account login. After the login flow returns to `gemini.google.com`, K.I.T.T. attaches through CDP and continues normal UI automation.

This is not a stealth or CAPTCHA-bypass path. Authentication, account selection, MFA and security challenges remain user-controlled. Set `KITT_CHROME_BIN` only when stable Chrome is installed in a non-standard location.

For a custom web chat:

```bash
kitt-reverse-proxy https://example.com/chat --provider generic --transport auto
```

For generic chats, `auto` tries network discovery first and falls back to the normal UI path if bootstrap discovery cannot be established. The failed request is **not replayed** across transports.

---

## Providers & models

The default provider-plugin set is deliberately small and curated rather than quantity-driven. The registry can be extended with explicitly loaded trusted plugins.

| Provider | API model | Default transport | UI image input | Reasoning ownership |
| --- | --- | --- | --- | --- |
| ChatGPT | `chatgpt-web` | UI | Yes | WebChat UI |
| Claude | `claude-web` | UI | Yes | WebChat UI |
| Gemini | `gemini-web` | UI | Yes | WebChat UI |
| Kimi | `kimi-web` | UI | No | WebChat UI |
| DeepSeek | `deepseek-web` | UI | No | WebChat UI |
| Generic web chat | `adaptive-web-chat` | Network → UI fallback | Depends on target | Target WebChat |

For browser-backed providers, the proxy never changes the model's reasoning/thinking level from API headers, agent settings or injected prompts. Configure reasoning directly in the authenticated WebChat when the provider exposes that control. Legacy `X-Kitt-Reasoning-Effort` headers are accepted only for compatibility and ignored.

Discovery endpoints:

```text
GET /v1/providers
GET /v1/providers/:provider
GET /v1/providers/:provider/models
GET /v1/models
GET /v1/capabilities
```

Provider records include supported transports, route-model aliases, static capabilities and live resilience state for the active runtime.

### Provider plugins and SDK

Default WebChat integrations are isolated from the gateway core under `src/plugins/default/`. The core resolves providers through a versioned registry, so adding a provider no longer requires editing the runtime factory or transport executors.

The public development contract is exported as `kitt-reverse-proxy/plugin-sdk`:

```ts
import { defineProviderPlugin } from 'kitt-reverse-proxy/plugin-sdk';

export default defineProviderPlugin({
  apiVersion: 1,
  version: '1.0.0',
  provider: {
    id: 'acme',
    name: 'Acme Web',
    hosts: ['chat.acme.example'],
    defaultApiModel: 'acme-web',
    preferredTransport: 'ui',
    transports: ['ui'],
    auth: 'browser-profile',
    capabilities: {
      streaming: true,
      tools: 'protocol',
      structuredOutput: 'best_effort',
      systemMessages: 'native-or-emulated',
      reasoning: false
    },
    models: [{ id: 'acme-web', aliases: ['acme'] }],
    ui: {
      selectorVersion: 1,
      inputSelectors: ['textarea'],
      sendSelectors: ['button[type="submit"]'],
      responseSelectors: ['[data-role="assistant"]'],
      streamingSelectors: ['[data-is-streaming="true"]'],
      supportsImageUpload: false
    }
  }
});
```

Load trusted local modules or npm packages explicitly:

```bash
kitt-reverse-proxy https://chat.acme.example/ \
  --provider acme \
  --provider-plugin ./plugins/acme-provider.mjs

kitt-reverse-proxy https://chat.acme.example/ \
  --provider acme \
  --provider-plugin @acme/kitt-provider
```

`PROXY_PROVIDER_PLUGINS` accepts a comma-separated module list for managed launches. Plugins are resolved once during bootstrap; request execution keeps the same direct `ProviderPreset` hot path. Remote URL/data/node module specifiers are rejected and there is no automatic filesystem discovery.

Provider modules are trusted code loaded into the proxy process. Install or load only plugins whose source you trust; see `SECURITY.md`.

---

## Reliability & performance

K.I.T.T. keeps resilience on the safe side of chat semantics:

- **No automatic replay of dispatched chat POSTs.** A network interruption after dispatch may mean the provider already accepted the prompt, so transparent request retries are intentionally avoided.
- **Circuit breaker per session/transport.** Three consecutive availability failures open the circuit for 30 seconds; the next eligible request becomes a half-open probe.
- **Low-overhead health tracking.** Success/failure counters and an in-memory latency EWMA add constant work per request.
- **Health-aware readiness.** `/readyz` returns `503` while the active provider circuit is open.
- **Bounded queues and sessions.** Named sessions use bounded serial lanes plus count, browser-page and resident-RSS budgets. Pressure-based LRU reclamation only targets idle recyclable named sessions; sessions waiting for client tool results remain pinned until continuation.
- **Cancellation propagation.** Client disconnects flow through request lifecycle, queue and executor layers.
- **Progressive streaming.** UI streaming emits suffix deltas instead of buffering every cumulative page snapshot.

Provider resilience events are available in JSON and Prometheus output through `/v1/kitt/metrics` as `provider_events_total`.

### Hybrid UI read path (4.6)

UI providers still send every message through the authenticated browser UI exactly once. Response reading now has a conservative hybrid path:

- the existing DOM monitor is always the canonical reader and remains armed for the complete turn;
- `--read-mode auto` attaches a passive Chromium CDP stream tap and observes candidate response bytes without modifying requests, responses, cookies or page JavaScript;
- a newly learned tap remains in **shadow** mode until its decoded text matches the final DOM text for several consecutive turns (default: 3);
- only a trusted tap may emit early streaming deltas; the final completion text still comes from the DOM;
- any attach, match, first-byte, stall, decode, verification or stream failure demotes the tap and continues through the DOM without resending the prompt;
- tap failures use an independent per-session circuit breaker, so a broken tap never marks the provider itself unavailable;
- `--read-mode dom` is the global kill switch and does not attach CDP at all.

The tap profile is learned in memory from origin/path/method/content-type/framing/text-path only. It does not persist request bodies, cookies, authorization headers or tokens. `/v1/kitt/status` and `/v1/capabilities` expose read-path health without response content.

Hybrid read controls:

```text
--read-mode <auto|dom|tap>       default: auto
--tap-match-timeout-ms <ms>      default: 4000
--tap-first-byte-ms <ms>         default: 8000
--tap-stall-ms <ms>              default: 5000
--tap-max-bytes <bytes>          default: 8388608
--tap-breaker-threshold <n>      default: 3
--tap-breaker-cooldown-s <s>     default: 300
--tap-verify-turns <n>           default: 3
```

Equivalent environment variables use the `PROXY_` prefix: `PROXY_READ_MODE`, `PROXY_TAP_MATCH_TIMEOUT_MS`, `PROXY_TAP_FIRST_BYTE_MS`, `PROXY_TAP_STALL_MS`, `PROXY_TAP_MAX_BYTES`, `PROXY_TAP_BREAKER_THRESHOLD`, `PROXY_TAP_BREAKER_COOLDOWN_S` and `PROXY_TAP_VERIFY_TURNS`. Control Center keys live under `reverse_proxy.runtime` using the corresponding snake_case names.

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
```

`X-Kitt-Reasoning-Effort` is a deprecated compatibility header. If an older client still sends it, the proxy ignores it; it never changes the WebChat reasoning setting.

Chat Completions streaming uses standard SSE and terminates with `[DONE]`. Native tool calls are reconstructed for the Agent CLI round trip. `parallel_tool_calls=false` remains the recommended K.I.T.T. path.

---

## Sessions

A single authenticated browser can host multiple logical conversations. Named `X-Kitt-Session-Id` values receive independent tabs in the same persistent browser context instead of launching one Chromium process per conversation.

K.I.T.T. Agent CLI child agents use stable named session identities: sibling children map to different named sessions/tabs, while a retained child reuses the same named session when it receives another task. Distinct named session IDs are never merged into one browser conversation.

Session behavior includes bounded concurrent capacity, independent bounded chat/browser-automation lanes, idle timeout cleanup plus resource-pressure LRU reclamation, explicit reset/delete endpoints, stable conversation IDs across Agent CLI turns and circuit-breaker state isolated with the session executor.

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
--provider <id>              auto|default-id|<plugin-id>
--provider-plugin <module>   trusted local/npm provider plugin (repeatable)
--transport <mode>           auto|ui|network
--api-model <id>             model ID exposed through the API
--user-data-dir <dir>        persistent Chromium profile
--cdp-url <url>              attach to an existing browser
--max-sessions <n>           maximum live sessions
--max-queue <n>              bounded queue depth
--session-idle-timeout <s>   idle session eviction timeout
--max-browser-pages <n>      browser-page budget before idle LRU reclamation
--max-rss-mb <n>             proxy RSS budget before idle LRU reclamation
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

Keep changes focused on deterministic gateway behavior, bounded resource use, provider compatibility and agent-facing protocol quality. New provider support should use the provider-plugin SDK, include capability metadata and conformance tests, and keep a clear security model. Provider code is loaded only from explicitly configured local/npm modules; runtime-downloaded provider code is not supported.

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


## Multi-instance control plane

K.I.T.T. Reverse Proxy exposes a small, machine-readable multi-instance control plane for running more than one browser-backed provider at the same time. Since 4.3, lifecycle management uses an optional resident loopback controller; each model-serving proxy endpoint remains an independent service process, while registries under `~/.kitt-reverse-proxy/control/` provide crash/restart recovery.

### List provider plugins

```bash
kitt-reverse-proxy plugins list --json
```

The response is derived from the provider-plugin registry, so Agent CLI does not hard-code ChatGPT, Claude, Gemini, Kimi or DeepSeek.

### Named browser profiles

```bash
kitt-reverse-proxy profiles create context-google --provider gemini
kitt-reverse-proxy profiles create coding-openai --provider chatgpt
kitt-reverse-proxy profiles list --json
```

Profiles are dedicated Chromium user-data directories and must be treated as credential material. The registry stores metadata and paths only; passwords, cookies and tokens remain inside the browser profile. Existing provider directories such as `~/.kitt-reverse-proxy/gemini` are imported as legacy profiles without moving their browser data.

A profile can be associated with multiple providers over time. Reverse Proxy 4.4 preserves the single-owner user-data invariant by introducing a profile-scoped BrowserHost: compatible managed services may share that one live Chrome owner through loopback CDP, while service processes never open the same profile independently. Gemini is intentionally excluded so its human Google-auth bootstrap remains unchanged.

### Multiple services

Ports are allocated automatically from 3000-3099 unless `--port` is specified.

```bash
kitt-reverse-proxy service start gemini \
  --id gemini-context \
  --profile context-google \
  --json

kitt-reverse-proxy service start chatgpt \
  --id chatgpt-code \
  --profile coding-openai \
  --json

kitt-reverse-proxy service list --json
kitt-reverse-proxy service restart gemini-context --json
kitt-reverse-proxy service stop chatgpt-code --json
kitt-reverse-proxy service stop --all --json
```

This makes the intended Agent topology explicit: one instance can serve context gathering while another serves coding, with independent providers, profiles, ports and lifecycle.

See `docs/CONTROL_PLANE.md` for ownership boundaries and the JSON contract.

## Reverse Proxy 4.3 — resident control and lower contention

Version 4.3 keeps the existing per-service OpenAI-compatible endpoints but moves lifecycle discovery onto an optional resident loopback control process:

- `kitt-reverse-proxy control ensure --json` starts the lightweight control server on `127.0.0.1:2999` by default; override with `KITT_REVERSE_PROXY_CONTROL_PORT`.
- Agent CLI 0.73+ uses that channel for plugin/profile/service operations and falls back to the existing CLI contract when necessary.
- Chat execution and the dedicated browser-automation page use independent bounded serial queues, so browser inspection does not wait behind an unrelated provider response while ordering remains strict within each lane.
- `service stop --all` terminates independent services concurrently instead of accumulating per-process shutdown deadlines.
- `npm run benchmark:control` measures cold control bootstrap and warm p50/p95/p99 request latency without contacting a model.

The resident control process does not own authenticated browser sessions; service processes retain browser/profile isolation. This deliberately reduces CLI/process bootstrap overhead without weakening the existing profile ownership boundary.

## Reverse Proxy 4.4.2 — UI response and managed-start reliability

Patch 4.4.2 fixes two timeout paths exposed by long-running WebChat sessions and managed browser startup:

- the first useful UI delta now uses the configured `--ui-response-timeout` budget instead of an independent hard 90-second cutoff, so a configured 180-second response window is honored end to end;
- Gemini response discovery covers current `message-content` and nested markdown DOM variants while retaining the existing provider-specific selectors;
- managed `service start` readiness allows up to 330 seconds for visible Chromium and human-login bootstrap before declaring startup failure.

These changes keep the OpenAI-compatible API and control-plane schema unchanged.

## Reverse Proxy 4.4.1 — lifecycle hardening

Patch 4.4.1 hardens the multi-process lifecycle without changing the public model APIs:

- managed services and BrowserHosts persist a process fingerprint derived from process start/command identity; a recycled PID alone is never authority to terminate a process;
- profile/instance registry mutations use cross-process locks and service lifecycle operations use a broader lock, preventing lost JSON updates and competing start/stop allocation;
- service startup is published only after the spawned HTTP listener answers its liveness endpoint; failed starts roll back their owned child processes;
- pre-4.4.1 instance records without a process fingerprint are treated as stale rather than trusted for termination;
- session shutdown propagates cancellation and uses a bounded drain window so an executor that ignores cancellation cannot block shutdown indefinitely.

## Reverse Proxy 4.4 — browser-host pooling and resource budgets

Version 4.4 completes the performance roadmap without changing the OpenAI-compatible service endpoints:

- Managed services may share one native Chrome BrowserHost only when they use the same named browser profile. Different credential/user-data directories are never combined.
- Gemini remains on the dedicated human-authentication bootstrap path and is intentionally excluded from BrowserHost pooling.
- BrowserHost startup is opportunistic: if stable Chrome/CDP is unavailable, the first service falls back to the existing process-owned browser path.
- Session eviction is resource-aware: idle LRU candidates may be reclaimed for max-session pressure, browser-page pressure, or configured process RSS pressure. Busy sessions and sessions awaiting client tool results remain protected.
- The resident control plane keeps its ServiceManager and instance registry hot in memory; external file mutations are detected by mtime and atomic persistence remains authoritative.
- Native Chrome CDP polling now backs off during long manual-authentication waits and samples quickly again when the expected target returns.
- `npm run benchmark:runtime` reports live service/process-tree memory on Linux (PSS when available), BrowserHost topology and service-list latency. With `KITT_BENCH_TARGET=<provider|url>` it manages 1/2/4-service scenarios, measuring startup-to-ready, named-session creation p95, browser inspect p95 and shutdown; `KITT_BENCH_API_KEY` (or `PROXY_API_KEY`) is honored automatically.

Resource knobs:

```text
PROXY_MAX_BROWSER_PAGES=12
PROXY_MAX_RSS_MB=768
PROXY_BROWSER_HOST_POOL=true
```

The RSS signal is the reverse-proxy process RSS; browser page count is used as the portable browser-pressure signal. The runtime benchmark additionally measures the Linux process tree so Chromium cost is visible during performance testing.



## 4.6.2 code-hygiene gate

TypeScript validation now rejects unused locals and unused parameters in production/test compilation. This keeps stale transport, provider and browser-runtime branches from accumulating silently as the plugin architecture evolves.

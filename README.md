# K.I.T.T. Reverse Proxy

Local, loopback-first gateway that exposes authorized web-chat sessions through OpenAI-compatible, Responses, Anthropic and Ollama-shaped APIs. It is designed as the browser/provider edge for K.I.T.T. Agent CLI and other local agents.

## What it optimizes

- **Reuse authentication instead of duplicating clients.** Persistent browser profiles keep login state and the proxy automatically returns to headless mode after manual authentication when the provider allows it.
- **One browser process, many conversations.** Named `X-Kitt-Session-Id` conversations use independent tabs in an existing persistent authenticated context rather than spawning a Chromium process per chat.
- **Low-noise Chromium.** KITT disables nonessential first-run/default-app/background services while preserving normal page networking, authentication and service-worker behavior.
- **Stable agent protocol.** `X-Kitt-Session-Id` is conversation-stable, `X-Kitt-Request-Id` is request-unique, and `X-Kitt-Reasoning-Effort` (0-100) controls provider reasoning for the next turn when the selected web UI supports it.
- **No chain-of-thought extraction.** Reasoning control changes the provider mode/effort; it does not expose private reasoning.

## Install / update

### Linux / macOS

```bash
curl -fsSL https://raw.githubusercontent.com/rfdetoni/kitt-reverse-proxy/main/install.sh | bash
```

The installer clones/updates `main`, builds TypeScript, prunes development dependencies and uses an installed Chrome/Chromium when available. If no system browser exists it installs Playwright Chromium. Re-running the command updates the installation.

### Windows PowerShell

```powershell
irm https://raw.githubusercontent.com/rfdetoni/kitt-reverse-proxy/main/install.ps1 | iex
```

Requirements: Git, Node.js 20+ and npm.

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

`auto` browser mode first probes the stored profile headlessly. If login/intervention is required, KITT temporarily opens a visible browser, persists the authenticated profile, closes it and retries headless.

## Agent CLI integration

Configure Agent CLI with the reverse-proxy provider/endpoint. For each conversation it keeps the same session ID and forwards native tools plus reasoning effort. The proxy exposes:

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`
- `POST /api/chat`
- `GET /v1/models`
- `GET /v1/capabilities`
- `GET /v1/kitt/sessions`
- `POST /v1/kitt/reset`
- `GET /v1/kitt/metrics`

KITT-specific headers:

```text
X-Kitt-Session-Id: stable conversation id
X-Kitt-Request-Id: unique request id
X-Kitt-Reasoning-Effort: 0..100
```

For ChatGPT UI, reasoning effort is normalized to the closest available `Instant`, `Medium`, `High` or `Extra High` mode. If a level/provider is unavailable, the proxy reports a structured degradation/error and Agent CLI can retry without native reasoning rather than losing the turn.

## Browser ownership

A `--cdp-url` browser is user-owned. KITT attaches to it but does not intentionally terminate it during proxy shutdown. Persistent KITT profiles live under `~/.kitt-reverse-proxy/<provider>` by default.

For minimum RAM, prefer a system Chrome/Chromium plus the default persistent-profile mode, or attach an already-running browser with CDP. Named UI sessions share the authenticated browser process.

## Security

The API binds to loopback by default, validates browser origins, supports a local API key, bounds queues/sessions/body sizes and does not bypass CAPTCHA or provider security challenges. Manual challenges remain manual. See `SECURITY.md` for the security model and reporting process.

## Development

```bash
npm ci
npm run verify
```

The implementation is TypeScript/Node.js because the dominant workload is browser/HTTP orchestration; Playwright/Chromium remains the native browser automation layer rather than reimplementing browser protocol logic in another language.

## License

MIT. See `LICENSE`.

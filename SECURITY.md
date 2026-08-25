# Security Model

## Intended use

Use only with web chats, accounts and endpoints you are authorized to automate. The project does not include CAPTCHA solving, anti-bot evasion, credential harvesting, auth bypass or WAF bypass.

## No LLM-generated code

Version 2 removes the previous `node:vm` design entirely. Ollama can only return a validated JSON mapping profile. Allowed operations are represented by enums and JSON paths interpreted by trusted TypeScript code.

This removes an unnecessary code-execution boundary and makes profiles reviewable before reuse.

## Session material

The live browser context may contain cookies, authorization headers, CSRF values and other credentials.

- cookies stay in Playwright's non-persistent BrowserContext by default;
- captured `cookie`, `content-length`, `host` and hop-by-hop headers are not replayed manually;
- the APIRequestContext associated with BrowserContext supplies its cookie jar;
- profiles never contain captured headers or request samples;
- secrets are structurally redacted before request/response samples are sent to the local Ollama model;
- profiles saved by `--save-profile` use file mode `0600` where supported.

## Network

The proxy binds to `127.0.0.1` by default. Binding to a non-loopback address is rejected unless `--api-key` or `PROXY_API_KEY` is configured.

API key comparison is timing-safe for equal-length values.

CORS, when enabled, accepts only localhost/loopback browser origins. Non-browser clients are unaffected by CORS.

## Upstream protections

- the endpoint must be HTTP(S);
- discovery only accepts endpoints under the same approximate site domain as the page;
- redirects are bounded and configurable (`--no-redirects` / `--follow-redirects`);
- request queue is bounded;
- stateful calls are serialized;
- response body size is capped before parsing;
- upstream error bodies are not returned to API clients.

## Known limitations

A site's own terms, rate limits and authorization rules still apply. The browser being able to access a page does not imply permission to automate it.

The approximate same-site check is intentionally conservative but is not a full Public Suffix List implementation. Sites that legitimately host chat APIs on unrelated domains may require a future explicit allowlist feature rather than weakening the default policy.

# Optional local browser file transfer

Start the UI proxy with `--browser-file-transfer`, loopback binding and an
API key of at least 32 characters. File transfer is disabled by default.
Use the authenticated browser management endpoints for the isolated session.

- POST /v1/kitt/browser/upload: selector, simple filename, canonical data_base64.
  At most 32 KiB. Never passes a host filesystem path to Playwright. Selecting
  a file can trigger page code or submission; authorize the destination first.
- POST /v1/kitt/browser/download: same-origin HTTP(S) URL, optional timeout_ms.
  GET only, redirects rejected, at most 256 KiB, returns data_base64 and SHA-256.
  It does not save a host file. It is not a generic click-download handler.

In this opt-in mode the clean context blocks out-of-scope HTTP(S) requests,
WebSockets, popups and service workers. This is a browser policy, not an OS
network sandbox or complete protection against hostile browser/renderer code,
DNS rebinding or malicious allowed sites. Use trusted origin scopes. The
default automation behavior remains unchanged. The Agent artifact integration
is not yet wired; the operator invokes these API endpoints directly.

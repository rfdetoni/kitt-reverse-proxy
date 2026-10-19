# Runtime images and SlimToolkit

The default runtime is multi-stage Node 24 slim + non-root UID 10001 + `tini`, and uses a separate browser sidecar. The `standalone` target embeds Playwright Chromium and native browser dependencies; do not use automatic Slim pruning as part of releases. NPM downloads are cached at build time; a built-in Node health check calls `/healthz`.

Run `bash scripts/slim-audit.sh IMAGE_TAG` for read-only image analysis with SlimToolkit 1.40.11. Any experimental minification must validate real headed/headless Chromium login flows, provider redirects, browser profile storage, fonts, CA certificates, media libs, and graceful shutdown. Compare the runtime and standalone targets independently.

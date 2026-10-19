#!/usr/bin/env bash
set -euo pipefail
IMAGE="${1:?Usage: slim-audit.sh IMAGE_TAG}"
command -v docker >/dev/null || exit 1
command -v slim >/dev/null || { echo "SlimToolkit CLI required" >&2; exit 1; }
docker image inspect --format '{{.RepoTags}} {{.Size}} bytes (uncompressed virtual)' "$IMAGE"
slim xray "$IMAGE"
echo "Only xray analysis: Chromium/Playwright, its native libraries, sandbox and fonts must never be pruned without end-to-end browser tests."

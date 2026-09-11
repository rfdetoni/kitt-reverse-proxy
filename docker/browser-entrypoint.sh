#!/bin/sh
set -eu

PROFILE_DIR="${KITT_BROWSER_PROFILE:-/data/browser}"
MODE="${KITT_BROWSER_MODE:-headless}"
DISPLAY_VALUE="${DISPLAY:-:99}"

mkdir -p "$PROFILE_DIR"

case "$MODE" in
  headless)
    BROWSER_MODE_ARGS="--headless=new"
    ;;
  headed)
    Xvfb "$DISPLAY_VALUE" -screen 0 "${KITT_BROWSER_SCREEN:-1440x900x24}" -nolisten tcp &
    xvfb_pid=$!

    # Keep VNC local to the container; noVNC is the only published UI surface.
    x11vnc \
      -display "$DISPLAY_VALUE" \
      -forever \
      -shared \
      -nopw \
      -localhost \
      -rfbport 5900 \
      >/tmp/x11vnc.log 2>&1 &
    vnc_pid=$!

    websockify \
      --web=/usr/share/novnc/ \
      0.0.0.0:6080 \
      127.0.0.1:5900 \
      >/tmp/novnc.log 2>&1 &
    novnc_pid=$!

    cleanup() {
      kill "$novnc_pid" "$vnc_pid" "$xvfb_pid" 2>/dev/null || true
    }
    trap cleanup EXIT INT TERM
    BROWSER_MODE_ARGS=""
    ;;
  *)
    echo "Unsupported KITT_BROWSER_MODE: $MODE (expected headless or headed)" >&2
    exit 2
    ;;
esac

# CDP stays inside the Docker network. The Compose file exposes only noVNC on
# host loopback for manual authentication.
# shellcheck disable=SC2086
exec chromium \
  $BROWSER_MODE_ARGS \
  --user-data-dir="$PROFILE_DIR" \
  --remote-debugging-address=0.0.0.0 \
  --remote-debugging-port=9222 \
  --remote-allow-origins='*' \
  --no-first-run \
  --no-default-browser-check \
  --password-store=basic \
  about:blank

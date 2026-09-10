#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${KITT_PROXY_REPO:-https://github.com/rfdetoni/kitt-reverse-proxy.git}"
REF="${KITT_PROXY_REF:-main}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
INSTALL_ROOT="${KITT_PROXY_HOME:-$DATA_HOME/kitt-reverse-proxy}"
BIN_DIR="${KITT_BIN_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}"
INSTALL_BROWSER=auto
UNINSTALL=0

usage() {
  cat <<'EOF'
K.I.T.T. Reverse Proxy installer/updater
Usage: install.sh [--ref REF] [--browser auto|bundled|system] [--uninstall]
EOF
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) REF="${2:?missing ref}"; shift 2 ;;
    --browser) INSTALL_BROWSER="${2:?missing browser mode}"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ "$INSTALL_BROWSER" =~ ^(auto|bundled|system)$ ]] || { echo "Invalid browser mode" >&2; exit 2; }

SRC="$INSTALL_ROOT/src"
BIN_PROXY="$BIN_DIR/kitt-reverse-proxy"
BIN_GATEWAY="$BIN_DIR/kitt-agent-gateway"
if [[ $UNINSTALL -eq 1 ]]; then
  rm -rf "$INSTALL_ROOT"
  rm -f "$BIN_PROXY" "$BIN_GATEWAY"
  echo "K.I.T.T. Reverse Proxy removed."
  exit 0
fi

command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
command -v node >/dev/null || { echo "Node.js 24+ is required" >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required" >&2; exit 1; }
node -e "const m=Number(process.versions.node.split('.')[0]); if(m<24) process.exit(1)" || { echo "Node.js 24+ is required" >&2; exit 1; }

mkdir -p "$INSTALL_ROOT" "$BIN_DIR"
if [[ ! -d "$SRC/.git" ]]; then
  rm -rf "$SRC"
  git clone --filter=blob:none --no-checkout "$REPO_URL" "$SRC"
fi
git -C "$SRC" remote set-url origin "$REPO_URL"
git -C "$SRC" fetch --force --depth 1 origin "$REF"
git -C "$SRC" checkout --detach --force FETCH_HEAD
git -C "$SRC" clean -ffd

(cd "$SRC" && npm ci --no-audit --no-fund --strict-allow-scripts && npm run build && npm prune --omit=dev --no-audit --no-fund)

has_system_browser=0
for candidate in google-chrome google-chrome-stable chromium chromium-browser; do
  if command -v "$candidate" >/dev/null 2>&1; then has_system_browser=1; break; fi
done
if [[ "$INSTALL_BROWSER" == bundled || ( "$INSTALL_BROWSER" == auto && $has_system_browser -eq 0 ) ]]; then
  (cd "$SRC" && npx --yes playwright install chromium)
fi

cat >"$BIN_PROXY" <<EOF
#!/usr/bin/env bash
exec node "$SRC/dist/cli.js" "\$@"
EOF
cat >"$BIN_GATEWAY" <<EOF
#!/usr/bin/env bash
exec node "$SRC/dist/gateway/cli.js" "\$@"
EOF
chmod +x "$BIN_PROXY" "$BIN_GATEWAY"
"$BIN_PROXY" --help >/dev/null
echo "K.I.T.T. Reverse Proxy installed/updated at $INSTALL_ROOT."
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "Add $BIN_DIR to PATH." ;; esac

#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${KITT_PROXY_REPO:-https://github.com/rfdetoni/kitt-reverse-proxy.git}"
REF="${KITT_PROXY_REF:-stable}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
INSTALL_ROOT="${KITT_PROXY_HOME:-$DATA_HOME/kitt-reverse-proxy}"
CACHE_ROOT="${KITT_PROXY_CACHE:-$CACHE_HOME/kitt-reverse-proxy}"
BIN_DIR="${KITT_BIN_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}"
INSTALL_BROWSER=auto
UNINSTALL=0
JOBS="${KITT_INSTALL_JOBS:-0}"
START_TS="$(date +%s)"

usage() {
  cat <<'EOF'
K.I.T.T. Reverse Proxy installer/updater
Usage: install.sh [--ref stable|REF] [--browser auto|bundled|system] [--jobs N] [--uninstall]

The default ref is "stable", resolved from the latest published GitHub release.
Stable/tag installs prefer the precompiled portable runtime bundle and skip npm install
and TypeScript compilation completely. Older releases fall back to the npm release package.
Use --ref main only when you intentionally want unreleased source code.

Performance tuning:
  --jobs N / KITT_INSTALL_JOBS=N   Network/build parallelism (auto by default)
  KITT_NPM_SOCKETS=N               npm HTTP connection pool size (auto by default)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) REF="${2:?missing ref}"; shift 2 ;;
    --browser) INSTALL_BROWSER="${2:?missing browser mode}"; shift 2 ;;
    --jobs) JOBS="${2:?missing job count}"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

[[ "$INSTALL_BROWSER" =~ ^(auto|bundled|system)$ ]] || { echo "Invalid browser mode" >&2; exit 2; }
[[ "$JOBS" =~ ^[0-9]+$ ]] || { echo "Invalid --jobs value: $JOBS" >&2; exit 2; }

RUNTIME="$INSTALL_ROOT/runtime"
SRC="$INSTALL_ROOT/src"
BIN_PROXY="$BIN_DIR/kitt-reverse-proxy"
BIN_GATEWAY="$BIN_DIR/kitt-agent-gateway"

if [[ $UNINSTALL -eq 1 ]]; then
  rm -rf "$INSTALL_ROOT"
  rm -f "$BIN_PROXY" "$BIN_GATEWAY"
  echo "K.I.T.T. Reverse Proxy removed."
  exit 0
fi

command -v node >/dev/null || { echo "Node.js 24+ is required" >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required" >&2; exit 1; }
node -e "const m=Number(process.versions.node.split('.')[0]); if(m<24) process.exit(1)" ||
  { echo "Node.js 24+ is required" >&2; exit 1; }

CPU_COUNT="$(node -e 'const os=require("node:os"); process.stdout.write(String(os.availableParallelism?.() || os.cpus().length || 1))')"
if [[ "$JOBS" -eq 0 ]]; then
  JOBS=$((CPU_COUNT * 2))
  (( JOBS < 4 )) && JOBS=4
  (( JOBS > 16 )) && JOBS=16
fi
NPM_SOCKETS="${KITT_NPM_SOCKETS:-$((JOBS * 4))}"
(( NPM_SOCKETS < 16 )) && NPM_SOCKETS=16
(( NPM_SOCKETS > 64 )) && NPM_SOCKETS=64
export npm_config_maxsockets="$NPM_SOCKETS"
export npm_config_prefer_offline=true
export npm_config_progress=false
export npm_config_jobs="$JOBS"
export GOMAXPROCS="$JOBS"

mkdir -p "$INSTALL_ROOT" "$CACHE_ROOT" "$BIN_DIR"
TMP_ROOT="$(mktemp -d "$INSTALL_ROOT/.install.XXXXXX")"
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

get_package_version() {
  local package_json="$1"
  [[ -f "$package_json" ]] || return 1
  node -e '
    try {
      const p=require(process.argv[1]);
      if (typeof p.version === "string" && p.version.trim()) process.stdout.write(p.version.trim());
      else process.exit(2);
    } catch { process.exit(2); }
  ' "$package_json"
}

runtime_package_json() {
  if [[ -f "$RUNTIME/package.json" ]]; then
    printf '%s' "$RUNTIME/package.json"
  elif [[ -f "$RUNTIME/node_modules/kitt-reverse-proxy/package.json" ]]; then
    printf '%s' "$RUNTIME/node_modules/kitt-reverse-proxy/package.json"
  else
    return 1
  fi
}

runtime_app_dir() {
  if [[ -f "$RUNTIME/dist/cli.js" ]]; then
    printf '%s' "$RUNTIME"
  elif [[ -f "$RUNTIME/node_modules/kitt-reverse-proxy/dist/cli.js" ]]; then
    printf '%s' "$RUNTIME/node_modules/kitt-reverse-proxy"
  else
    return 1
  fi
}

PREVIOUS_VERSION="not installed"
if RUNTIME_PACKAGE="$(runtime_package_json 2>/dev/null)" &&
   CURRENT_VERSION="$(get_package_version "$RUNTIME_PACKAGE" 2>/dev/null)"; then
  PREVIOUS_VERSION="v$CURRENT_VERSION"
elif CURRENT_VERSION="$(get_package_version "$SRC/package.json" 2>/dev/null)"; then
  PREVIOUS_VERSION="v$CURRENT_VERSION"
fi

github_slug() {
  local url="$1"
  case "$url" in
    https://github.com/*.git) printf '%s' "${url#https://github.com/}" | sed 's/\.git$//' ;;
    https://github.com/*) printf '%s' "${url#https://github.com/}" | sed 's/\.git$//' ;;
    git@github.com:*.git) printf '%s' "${url#git@github.com:}" | sed 's/\.git$//' ;;
    git@github.com:*) printf '%s' "${url#git@github.com:}" | sed 's/\.git$//' ;;
    *) return 1 ;;
  esac
}

GITHUB_SLUG="$(github_slug "$REPO_URL" 2>/dev/null || true)"
if [[ "$REF" == "stable" && -n "$GITHUB_SLUG" ]]; then
  if REF="$(node - "$GITHUB_SLUG" <<'NODE'
const slug = process.argv[2];
(async () => {
  const response = await fetch(`https://api.github.com/repos/${slug}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'kitt-installer' }
  });
  if (!response.ok) process.exit(2);
  const release = await response.json();
  if (typeof release.tag_name !== 'string' || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) process.exit(2);
  process.stdout.write(release.tag_name);
})().catch(() => process.exit(2));
NODE
  )"; then
    echo "Resolved stable release: $REF"
  else
    echo "Could not resolve latest published GitHub release; falling back to tag discovery." >&2
    REF=stable
  fi
fi

if [[ "$REF" == "stable" ]]; then
  command -v git >/dev/null || { echo "git is required when GitHub release discovery is unavailable" >&2; exit 1; }
  if ! REF="$(
    git ls-remote --refs --tags "$REPO_URL" 'refs/tags/v*' |
      node -e '
        const input = require("node:fs").readFileSync(0, "utf8");
        const versions = [...input.matchAll(/refs\/tags\/v(\d+)\.(\d+)\.(\d+)$/gm)]
          .map((m) => ({ tag: `v${m[1]}.${m[2]}.${m[3]}`, parts: [Number(m[1]), Number(m[2]), Number(m[3])] }));
        versions.sort((a, b) => a.parts[0]-b.parts[0] || a.parts[1]-b.parts[1] || a.parts[2]-b.parts[2]);
        if (!versions.length) process.exit(2);
        process.stdout.write(versions.at(-1).tag);
      '
  )"; then
    echo "Could not resolve a stable release tag from $REPO_URL" >&2
    exit 1
  fi
  echo "Resolved stable tag fallback: $REF"
fi

has_system_browser() {
  local candidate
  for candidate in google-chrome google-chrome-stable chrome chromium chromium-browser microsoft-edge microsoft-edge-stable; do
    command -v "$candidate" >/dev/null 2>&1 && return 0
  done
  if [[ "$(uname -s 2>/dev/null || true)" == "Darwin" ]]; then
    [[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]] && return 0
    [[ -x "/Applications/Chromium.app/Contents/MacOS/Chromium" ]] && return 0
    [[ -x "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" ]] && return 0
  fi
  return 1
}

NEED_BROWSER=0
if [[ "$INSTALL_BROWSER" == "bundled" ]]; then
  NEED_BROWSER=1
elif [[ "$INSTALL_BROWSER" == "auto" ]] && ! has_system_browser; then
  NEED_BROWSER=1
fi

download_file() {
  local url="$1"
  local dest="$2"
  local tmp="${dest}.part.$$"
  rm -f "$tmp"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --retry-delay 1 --connect-timeout 15 --speed-time 30 --speed-limit 1024 \
      --output "$tmp" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --tries=3 --timeout=30 -O "$tmp" "$url"
  else
    node - "$url" "$tmp" <<'NODE'
const fs = require('node:fs');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const [url, dest] = process.argv.slice(2);
(async () => {
  const response = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'kitt-installer' } });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${url}`);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(dest));
})().catch((error) => { console.error(error.message); process.exit(1); });
NODE
  fi
  mv -f "$tmp" "$dest"
}

checksum_for_file() {
  local file="$1"
  local sums="$2"
  awk -v name="$(basename "$file")" '$2 == name || $2 == "*"name {print $1; exit}' "$sums"
}

verify_release_checksum() {
  local file="$1"
  local sums="$2"
  [[ -s "$file" && -s "$sums" ]] || return 1
  local expected actual
  expected="$(checksum_for_file "$file" "$sums")"
  [[ "$expected" =~ ^[0-9a-fA-F]{64}$ ]] || return 1
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  else
    actual="$(node - "$file" <<'NODE'
const fs=require('node:fs'), crypto=require('node:crypto');
const h=crypto.createHash('sha256'), s=fs.createReadStream(process.argv[2]);
s.on('data',d=>h.update(d)); s.on('end',()=>process.stdout.write(h.digest('hex')));
NODE
)"
  fi
  [[ "$(printf %s "$actual" | tr "A-F" "a-f")" == "$(printf %s "$expected" | tr "A-F" "a-f")" ]]
}

BROWSER_PID=""
start_browser_install() {
  local version="$1"
  local log="$2"
  (
    set +e
    npm exec --yes --package="playwright@$version" -- playwright install chromium >"$log" 2>&1
    exit $?
  ) &
  BROWSER_PID=$!
}

wait_browser_install() {
  local log="$1"
  [[ -n "$BROWSER_PID" ]] || return 0
  if wait "$BROWSER_PID"; then
    BROWSER_PID=""
    return 0
  fi
  echo "Parallel Chromium install failed; retrying with installed Playwright." >&2
  [[ -f "$log" ]] && tail -n 30 "$log" >&2 || true
  BROWSER_PID=""
  return 1
}

write_launchers() {
  local app_dir="$1"
  cat >"$BIN_PROXY" <<EOF
#!/usr/bin/env bash
exec node "$app_dir/dist/cli.js" "\$@"
EOF
  cat >"$BIN_GATEWAY" <<EOF
#!/usr/bin/env bash
exec node "$app_dir/dist/gateway/cli.js" "\$@"
EOF
  chmod +x "$BIN_PROXY" "$BIN_GATEWAY"
}

install_cached_npm_archive() {
  local archive="$1"
  local stage="$2"
  mkdir -p "$stage"
  printf '{"private":true}\n' >"$stage/package.json"
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install \
    --prefix "$stage" \
    --omit=dev \
    --ignore-scripts \
    --no-audit \
    --no-fund \
    --no-package-lock \
    --no-save \
    --prefer-offline \
    --progress=false \
    "$archive"
}

FAST_PATH=0
if [[ -n "$GITHUB_SLUG" && "$REF" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  FAST_PATH=1
fi

APP_DIR=""
TARGET_VERSION=""

if [[ $FAST_PATH -eq 1 ]]; then
  TARGET_VERSION="${REF#v}"
  echo "Install mode: prebuilt release fast path ($REF)"
  echo "Parallelism: jobs=$JOBS, npm sockets=$NPM_SOCKETS"

  if EXISTING_APP="$(runtime_app_dir 2>/dev/null)" &&
     EXISTING_PACKAGE="$(runtime_package_json 2>/dev/null)" &&
     EXISTING_VERSION="$(get_package_version "$EXISTING_PACKAGE" 2>/dev/null)" &&
     [[ "$EXISTING_VERSION" == "$TARGET_VERSION" ]]; then
    APP_DIR="$EXISTING_APP"
    echo "Package v$TARGET_VERSION is already installed; skipping all package work."
    if [[ $NEED_BROWSER -eq 1 && -f "$RUNTIME/node_modules/playwright/cli.js" ]]; then
      node "$RUNTIME/node_modules/playwright/cli.js" install chromium
    fi
  else
    RELEASE_CACHE="$CACHE_ROOT/$REF"
    mkdir -p "$RELEASE_CACHE"
    SUMS="$RELEASE_CACHE/SHA256SUMS"
    META="$RELEASE_CACHE/package.json"
    BUNDLE="$RELEASE_CACHE/kitt-reverse-proxy-runtime-$TARGET_VERSION.tar.gz"
    NPM_ARCHIVE="$RELEASE_CACHE/kitt-reverse-proxy-$TARGET_VERSION.tgz"
    RELEASE_BASE="https://github.com/$GITHUB_SLUG/releases/download/$REF"
    RAW_PACKAGE="https://raw.githubusercontent.com/$GITHUB_SLUG/$REF/package.json"

    BROWSER_LOG="$TMP_ROOT/browser.log"
    if [[ ! -s "$META" ]]; then
      download_file "$RAW_PACKAGE" "$META" &
      META_PID=$!
    else
      META_PID=""
    fi
    if [[ ! -s "$SUMS" ]]; then
      download_file "$RELEASE_BASE/SHA256SUMS" "$SUMS" &
      SUMS_PID=$!
    else
      SUMS_PID=""
    fi

    BUNDLE_VALID=0
    if verify_release_checksum "$BUNDLE" "$SUMS" 2>/dev/null; then
      BUNDLE_VALID=1
    else
      rm -f "$BUNDLE"
      echo "Downloading portable runtime bundle..."
      download_file "$RELEASE_BASE/$(basename "$BUNDLE")" "$BUNDLE" &
      BUNDLE_PID=$!
    fi

    [[ -n "$META_PID" ]] && wait "$META_PID"
    META_VERSION="$(get_package_version "$META")"
    [[ "$META_VERSION" == "$TARGET_VERSION" ]] ||
      { echo "Release metadata version mismatch: tag=$TARGET_VERSION package=$META_VERSION" >&2; exit 1; }
    PLAYWRIGHT_VERSION="$(node -e 'const p=require(process.argv[1]); const v=p.dependencies?.playwright; if(typeof v==="string") process.stdout.write(v);' "$META")"

    if [[ $NEED_BROWSER -eq 1 && -n "$PLAYWRIGHT_VERSION" ]]; then
      echo "Starting Chromium download concurrently with runtime installation..."
      start_browser_install "$PLAYWRIGHT_VERSION" "$BROWSER_LOG"
    fi

    [[ -n "$SUMS_PID" ]] && wait "$SUMS_PID"
    if [[ $BUNDLE_VALID -eq 0 ]]; then
      if wait "$BUNDLE_PID" 2>/dev/null && verify_release_checksum "$BUNDLE" "$SUMS" 2>/dev/null; then
        BUNDLE_VALID=1
      else
        rm -f "$BUNDLE"
        echo "Portable runtime bundle unavailable for $REF; using npm release package fallback."
      fi
    else
      echo "Using verified runtime cache: $BUNDLE"
    fi

    STAGE="$TMP_ROOT/runtime"
    if [[ $BUNDLE_VALID -eq 1 ]] && command -v tar >/dev/null 2>&1; then
      mkdir -p "$STAGE"
      tar -xzf "$BUNDLE" -C "$STAGE"
      APP_STAGE="$STAGE"
    else
      if ! verify_release_checksum "$NPM_ARCHIVE" "$SUMS" 2>/dev/null; then
        rm -f "$NPM_ARCHIVE"
        download_file "$RELEASE_BASE/$(basename "$NPM_ARCHIVE")" "$NPM_ARCHIVE"
        verify_release_checksum "$NPM_ARCHIVE" "$SUMS" ||
          { echo "Release checksum validation failed for $REF" >&2; exit 1; }
      fi
      install_cached_npm_archive "$NPM_ARCHIVE" "$STAGE"
      APP_STAGE="$STAGE/node_modules/kitt-reverse-proxy"
    fi

    INSTALLED_VERSION="$(get_package_version "$APP_STAGE/package.json")"
    [[ "$INSTALLED_VERSION" == "$TARGET_VERSION" ]] ||
      { echo "Installed package version mismatch: expected $TARGET_VERSION got $INSTALLED_VERSION" >&2; exit 1; }
    [[ -f "$APP_STAGE/dist/cli.js" ]] ||
      { echo "Release payload does not contain dist/cli.js" >&2; exit 1; }

    if [[ $NEED_BROWSER -eq 1 && -n "$PLAYWRIGHT_VERSION" ]]; then
      if ! wait_browser_install "$BROWSER_LOG"; then
        node "$STAGE/node_modules/playwright/cli.js" install chromium
      fi
    fi

    OLD_RUNTIME="$INSTALL_ROOT/.runtime-old"
    rm -rf "$OLD_RUNTIME"
    if [[ -d "$RUNTIME" ]]; then mv "$RUNTIME" "$OLD_RUNTIME"; fi
    mv "$STAGE" "$RUNTIME"
    rm -rf "$OLD_RUNTIME"
    if [[ "$APP_STAGE" == "$STAGE" ]]; then
      APP_DIR="$RUNTIME"
    else
      APP_DIR="$RUNTIME/node_modules/kitt-reverse-proxy"
    fi
  fi
else
  echo "Install mode: source ($REF)"
  echo "Parallelism: jobs=$JOBS, npm sockets=$NPM_SOCKETS"
  command -v git >/dev/null || { echo "git is required for source installation" >&2; exit 1; }

  if [[ ! -d "$SRC/.git" ]]; then
    rm -rf "$SRC"
    mkdir -p "$SRC"
    git -C "$SRC" init -q
    git -C "$SRC" remote add origin "$REPO_URL"
  else
    git -C "$SRC" remote set-url origin "$REPO_URL"
  fi
  git -C "$SRC" fetch --force --depth 1 --no-tags origin "$REF"
  git -C "$SRC" checkout --detach --force FETCH_HEAD
  git -C "$SRC" clean -ffd

  TARGET_VERSION="$(get_package_version "$SRC/package.json")"
  PLAYWRIGHT_VERSION="$(node -e 'const p=require(process.argv[1]); const v=p.dependencies?.playwright; if(typeof v==="string") process.stdout.write(v);' "$SRC/package.json")"
  BROWSER_LOG="$TMP_ROOT/browser.log"
  if [[ $NEED_BROWSER -eq 1 && -n "$PLAYWRIGHT_VERSION" ]]; then
    echo "Starting Chromium download concurrently with npm ci/build..."
    start_browser_install "$PLAYWRIGHT_VERSION" "$BROWSER_LOG"
  fi

  (
    cd "$SRC"
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci \
      --no-audit --no-fund --strict-allow-scripts --prefer-offline --progress=false
    if ! node scripts/build-fast.mjs; then
      echo "Fast multicore build unavailable; falling back to TypeScript compiler." >&2
      npm run build
    fi
  )

  if [[ $NEED_BROWSER -eq 1 && -n "$PLAYWRIGHT_VERSION" ]]; then
    if ! wait_browser_install "$BROWSER_LOG"; then
      node "$SRC/node_modules/playwright/cli.js" install chromium
    fi
  fi
  APP_DIR="$SRC"
fi

[[ -n "$TARGET_VERSION" && -f "$APP_DIR/dist/cli.js" ]] ||
  { echo "Installation did not produce a runnable dist/cli.js" >&2; exit 1; }

echo "Version: $PREVIOUS_VERSION -> v$TARGET_VERSION"
write_launchers "$APP_DIR"
"$BIN_PROXY" --help >/dev/null

ELAPSED=$(( $(date +%s) - START_TS ))
echo "K.I.T.T. Reverse Proxy v$TARGET_VERSION installed/updated at $INSTALL_ROOT in ${ELAPSED}s."
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "Add $BIN_DIR to PATH." ;; esac

#!/usr/bin/env bash
set -euo pipefail

ESTACODA_HOME="${ESTACODA_HOME:-$HOME/.estacoda}"
ESTACODA_BIN="$ESTACODA_HOME/bin"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

# Normalize architecture names
if [ "$ARCH" = "x86_64" ]; then
  ARCH="x64"
elif [ "$ARCH" = "aarch64" ]; then
  ARCH="arm64"
fi

PLATFORM="${OS}-${ARCH}"

echo "EstaCoda installer"
echo "Platform: $PLATFORM"

# Check for Node
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js >= 22.18.0 is required but not found."
  echo "Install Node.js: https://nodejs.org/"
  exit 1
fi

NODE_VERSION="$(node --version 2>/dev/null || echo "v0.0.0")"
if ! node -e 'const [major, minor, patch] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && (minor > 18 || (minor === 18 && patch >= 0))) ? 0 : 1);' >/dev/null 2>&1; then
  echo "Node.js >= 22.18.0 is required. Found: $NODE_VERSION"
  exit 1
fi
echo "Node: $NODE_VERSION"

if ! command -v corepack >/dev/null 2>&1; then
  echo "Corepack is required to activate pnpm."
  echo "Install a Node.js distribution that includes Corepack, or install pnpm manually."
  exit 1
fi

mkdir -p "$ESTACODA_BIN"

# Try to determine release artifact URL
# v0.1.0 dev fallback: no prebuilt binaries yet
RELEASE_BASE="https://github.com/kemetresearch/estacoda/releases/latest"
ARTIFACT_URL=""

# Probe for a published artifact (this will 404 until v0.1.0 is tagged)
if command -v curl >/dev/null 2>&1; then
  ARTIFACT_URL="${RELEASE_BASE}/download/estacoda-${PLATFORM}"
  if ! curl -fsSL -I "$ARTIFACT_URL" >/dev/null 2>&1; then
    ARTIFACT_URL=""
  fi
fi

if [ -n "$ARTIFACT_URL" ]; then
  echo "Downloading release artifact..."
  curl -fsSL "$ARTIFACT_URL" -o "$ESTACODA_BIN/estacoda"
  chmod +x "$ESTACODA_BIN/estacoda"
else
  echo "No prebuilt binary found for $PLATFORM."
  echo "Building dist/ and installing Node wrapper..."

  # Determine repo root relative to this script
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

  (
    cd "$REPO_ROOT"
    if ! corepack enable; then
      if ! command -v pnpm >/dev/null 2>&1; then
        echo "Corepack failed to enable pnpm, and pnpm is not available on PATH." >&2
        exit 1
      fi
      echo "Corepack enable failed; using existing pnpm from PATH."
    fi
    CI=true pnpm install --frozen-lockfile
    pnpm run build
  )

  cat > "$ESTACODA_BIN/estacoda" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="REPO_ROOT_PLACEHOLDER"
ENTRYPOINT="$REPO_ROOT/dist/index.js"
if [ ! -f "$ENTRYPOINT" ]; then
  echo "EstaCoda dist entrypoint not found: $ENTRYPOINT" >&2
  echo "Run: cd \"$REPO_ROOT\" && pnpm install && pnpm run build" >&2
  exit 1
fi
exec node "$ENTRYPOINT" "$@"
WRAPPER

  sed -i.bak "s|REPO_ROOT_PLACEHOLDER|$REPO_ROOT|g" "$ESTACODA_BIN/estacoda"
  rm -f "$ESTACODA_BIN/estacoda.bak"
  chmod +x "$ESTACODA_BIN/estacoda"
fi

# Add to PATH if not already present
add_to_path() {
  local shell_rc=""
  case "${SHELL:-}" in
    */zsh) shell_rc="$HOME/.zshrc" ;;
    */bash) shell_rc="$HOME/.bashrc" ;;
    */fish) shell_rc="$HOME/.config/fish/config.fish" ;;
    *) shell_rc="$HOME/.profile" ;;
  esac

  if [ -n "$shell_rc" ] && [ -f "$shell_rc" ]; then
    if ! grep -q "ESTACODA_HOME" "$shell_rc" 2>/dev/null; then
      echo ""
      echo "# EstaCoda" >> "$shell_rc"
      echo 'export ESTACODA_HOME="$HOME/.estacoda"' >> "$shell_rc"
      echo 'export PATH="$ESTACODA_HOME/bin:$PATH"' >> "$shell_rc"
      echo "Added to $shell_rc"
    fi
  fi

  # Also try ~/.local/bin if it exists in PATH
  if [ -d "$HOME/.local/bin" ] && [[ ":$PATH:" == *":$HOME/.local/bin:"* ]]; then
    if [ ! -e "$HOME/.local/bin/estacoda" ]; then
      ln -sf "$ESTACODA_BIN/estacoda" "$HOME/.local/bin/estacoda" 2>/dev/null || true
    fi
  fi
}

if [ "${ESTACODA_SKIP_PATH_UPDATE:-0}" = "1" ]; then
  echo "Skipping shell PATH update because ESTACODA_SKIP_PATH_UPDATE=1"
else
  add_to_path
fi

echo ""
echo "EstaCoda installed to $ESTACODA_BIN/estacoda"
echo ""
echo "Next steps:"
echo "  1. Restart your shell or run: export PATH=\"$ESTACODA_HOME/bin:\$PATH\""
echo "  2. Run: estacoda init"
echo "  3. Run: estacoda verify"
echo "  4. Run: estacoda"

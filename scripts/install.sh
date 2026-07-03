#!/usr/bin/env bash
set -euo pipefail

INSTALLER_VERSION="v0.1.0-prerelease"
DEFAULT_SOURCE_URL="https://github.com/sifr01-labs/EstaCoda.git"
SOURCE_URL="${ESTACODA_SOURCE_URL:-$DEFAULT_SOURCE_URL}"
BRANCH="${ESTACODA_BRANCH:-main}"
INSTALL_DIR=""
SKIP_INIT=0
FORCE_FHS=0

usage() {
  cat <<'USAGE'
EstaCoda source installer

Usage:
  curl -fsSLO https://raw.githubusercontent.com/sifr01-labs/EstaCoda/main/scripts/install.sh
  less install.sh
  bash install.sh
  bash scripts/install.sh [--branch <branch>] [--dir <path>] [--skip-init] [--fhs]

Options:
  --branch <branch>  Clone or update the managed install from this branch (default: main)
  --dir <path>       Install into a custom managed source directory
  --skip-init        Do not run `estacoda init` after building
  --fhs              Use Linux FHS paths: /usr/local/lib/estacoda and /usr/local/bin
  -h, --help         Show this help without changing files
USAGE
}

die() {
  echo "Error: $*" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --branch)
      [ "$#" -ge 2 ] || die "--branch requires a value"
      BRANCH="$2"
      shift 2
      ;;
    --dir)
      [ "$#" -ge 2 ] || die "--dir requires a value"
      INSTALL_DIR="$2"
      shift 2
      ;;
    --skip-init)
      SKIP_INIT=1
      shift
      ;;
    --fhs)
      FORCE_FHS=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
done

if [ -z "$BRANCH" ]; then
  die "Branch must not be empty"
fi

resolve_path() {
  local path="$1"
  mkdir -p "$(dirname "$path")"
  (
    cd "$(dirname "$path")"
    printf '%s/%s\n' "$(pwd -P)" "$(basename "$path")"
  )
}

shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

is_termux() {
  [ -n "${TERMUX_VERSION:-}" ] || [[ "${PREFIX:-}" == *"/com.termux/"* ]]
}

detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$arch" in
    x86_64|amd64|arm64|aarch64) ;;
    *) die "Unsupported CPU architecture: $arch" ;;
  esac

  case "$os" in
    Darwin)
      if command_exists sw_vers; then
        local mac_version mac_major
        mac_version="$(sw_vers -productVersion)"
        mac_major="${mac_version%%.*}"
        if [ "${mac_major:-0}" -lt 11 ]; then
          die "macOS 11 Big Sur or newer is required. Found: $mac_version"
        fi
      fi
      ;;
    Linux)
      if is_termux; then
        return 0
      fi
      if command_exists getconf && getconf GNU_LIBC_VERSION >/dev/null 2>&1; then
        return 0
      fi
      if command_exists ldd && ldd --version 2>&1 | head -n 1 | grep -Eiq 'glibc|gnu libc'; then
        return 0
      fi
      die "A modern Linux distribution with glibc is required for the v0.1.0 source installer."
      ;;
    *)
      die "Unsupported operating system: $os"
      ;;
  esac
}

validate_node() {
  if ! command_exists node; then
    die "Node.js >= 22.18.0 is required but was not found on PATH."
  fi
  local node_version
  node_version="$(node --version 2>/dev/null || true)"
  if ! node -e 'const [major, minor, patch] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && (minor > 18 || (minor === 18 && patch >= 0))) ? 0 : 1);' >/dev/null 2>&1; then
    die "Node.js >= 22.18.0 is required. Found: ${node_version:-unknown}"
  fi
  echo "Node: $node_version"
}

ensure_pnpm() {
  if command_exists corepack; then
    if ! corepack enable >/dev/null 2>&1; then
      echo "Warning: corepack enable failed; checking for pnpm on PATH." >&2
    fi
  else
    echo "Warning: Corepack was not found; checking for pnpm on PATH." >&2
  fi

  if ! command_exists pnpm; then
    die "pnpm is required. Install a Node.js distribution with Corepack or install pnpm manually."
  fi
  local pnpm_version
  if ! pnpm_version="$(pnpm --version 2>/dev/null)"; then
    die "pnpm is present but could not run. Check Corepack/pnpm installation and network access for package-manager activation."
  fi
  echo "pnpm: $pnpm_version"
}

require_git() {
  if ! command_exists git; then
    die "git is required for source installation."
  fi
}

choose_paths() {
  local os
  os="$(uname -s)"

  if [ -n "$INSTALL_DIR" ]; then
    INSTALL_DIR="$(resolve_path "$INSTALL_DIR")"
  elif [ "$FORCE_FHS" -eq 1 ] || { [ "${EUID:-$(id -u)}" -eq 0 ] && [ "$os" = "Linux" ] && ! is_termux; }; then
    INSTALL_DIR="/usr/local/lib/estacoda"
    FORCE_FHS=1
  else
    [ -n "${HOME:-}" ] || die "HOME is not set. Use --dir to choose an install directory."
    INSTALL_DIR="$HOME/.estacoda/estacoda"
  fi

  if [ "$FORCE_FHS" -eq 1 ]; then
    BIN_DIR="/usr/local/bin"
  elif is_termux; then
    [ -n "${PREFIX:-}" ] || die "PREFIX is required for Termux installs."
    BIN_DIR="$PREFIX/bin"
  else
    [ -n "${HOME:-}" ] || die "HOME is not set."
    BIN_DIR="$HOME/.local/bin"
  fi
}

stamp_matches_managed_install() {
  local stamp_path="$1"
  [ -f "$stamp_path" ] || return 1
  node --input-type=module - "$stamp_path" "$SOURCE_URL" "$BRANCH" <<'NODE'
import { readFileSync } from "node:fs";

const [stampPath, sourceUrl, branch] = process.argv.slice(2);
const stamp = JSON.parse(readFileSync(stampPath, "utf8"));
if (
  stamp.method === "managed-source" &&
  stamp.sourceUrl === sourceUrl &&
  stamp.branch === branch
) {
  process.exit(0);
}
process.exit(1);
NODE
}

clone_or_update_managed_source() {
  local stamp_path="$INSTALL_DIR/.install-method.json"

  if [ -d "$INSTALL_DIR/.git" ]; then
    if ! stamp_matches_managed_install "$stamp_path"; then
      die "Refusing to update $INSTALL_DIR because it is not stamped as this managed-source install."
    fi
    echo "Updating existing managed source install: $INSTALL_DIR"
    (
      cd "$INSTALL_DIR"
      git fetch origin "$BRANCH"
      git checkout "$BRANCH"
      git pull --ff-only origin "$BRANCH"
    )
    return 0
  fi

  if [ -e "$INSTALL_DIR" ] && [ "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')" != "0" ]; then
    die "Refusing to overwrite non-empty unmanaged directory: $INSTALL_DIR"
  fi

  mkdir -p "$(dirname "$INSTALL_DIR")"
  echo "Cloning EstaCoda $BRANCH into $INSTALL_DIR"
  git clone --branch "$BRANCH" "$SOURCE_URL" "$INSTALL_DIR"
}

build_source() {
  echo "Installing dependencies and building dist/"
  (
    cd "$INSTALL_DIR"
    CI=true pnpm install --frozen-lockfile
    pnpm run build
  )
}

write_wrapper() {
  local wrapper="$BIN_DIR/estacoda"
  local quoted_root
  quoted_root="$(shell_quote "$INSTALL_DIR")"
  mkdir -p "$BIN_DIR"

  if [ -e "$wrapper" ] || [ -L "$wrapper" ]; then
    if ! grep -Eq "Generated by scripts/(install|setup-estacoda)\\.sh|EstaCoda Node/dist wrapper|EstaCoda dist entrypoint" "$wrapper" 2>/dev/null; then
      die "Refusing to overwrite existing non-EstaCoda command: $wrapper"
    fi
  fi

  if [ -d "$wrapper" ]; then
    die "Refusing to overwrite existing non-EstaCoda command: $wrapper"
  fi

  cat > "$wrapper" <<WRAPPER
#!/usr/bin/env bash
set -euo pipefail
# EstaCoda source wrapper. Generated by scripts/install.sh.
REPO_ROOT=$quoted_root
ENTRYPOINT="\$REPO_ROOT/dist/index.js"
if [ ! -f "\$ENTRYPOINT" ]; then
  echo "EstaCoda dist entrypoint not found: \$ENTRYPOINT" >&2
  echo "Run: cd \"\$REPO_ROOT\" && corepack enable && pnpm install --frozen-lockfile && pnpm run build" >&2
  exit 1
fi
exec node "\$ENTRYPOINT" "\$@"
WRAPPER
  chmod +x "$wrapper"
}

write_stamp() {
  local stamp_path="$INSTALL_DIR/.install-method.json"
  node --input-type=module - "$stamp_path" "managed-source" "$SOURCE_URL" "$BRANCH" "$INSTALL_DIR" "$INSTALLER_VERSION" <<'NODE'
import { writeFileSync } from "node:fs";

const [stampPath, method, sourceUrl, branch, installDir, installerVersion] = process.argv.slice(2);
const stamp = {
  method,
  sourceUrl,
  branch,
  installDir,
  installedAt: new Date().toISOString(),
  installerVersion
};
writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`);
NODE
}

run_init() {
  if [ "$SKIP_INIT" -eq 1 ]; then
    echo "Skipping estacoda init because --skip-init was provided."
    return 0
  fi
  echo "Initializing EstaCoda state"
  HOME="${HOME:-}" "$BIN_DIR/estacoda" init
}

echo "EstaCoda source installer"
detect_platform
validate_node
require_git
ensure_pnpm
choose_paths

echo "Source: $SOURCE_URL"
echo "Branch: $BRANCH"
echo "Install dir: $INSTALL_DIR"
echo "Bin dir: $BIN_DIR"

clone_or_update_managed_source
build_source
write_stamp
write_wrapper
run_init

echo ""
echo "EstaCoda installed."
echo "Command: $BIN_DIR/estacoda"
echo ""
echo "Next steps:"
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo "  1. Add to PATH: export PATH=\"$BIN_DIR:\$PATH\""
  echo "  2. Run: estacoda setup"
  echo "  3. Run: estacoda"
else
  echo "  1. Run: estacoda setup"
  echo "  2. Run: estacoda"
fi

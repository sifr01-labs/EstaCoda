#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT=""
HOST_HOME="${HOME:-}"

cleanup() {
  if [ -n "$TMP_ROOT" ] && [ -d "$TMP_ROOT" ]; then
    rm -rf "$TMP_ROOT"
  fi
}
trap cleanup EXIT

die() {
  echo "Error: $*" >&2
  exit 1
}

assert_stamp_method() {
  local stamp_path="$1"
  local method="$2"
  node --input-type=module - "$stamp_path" "$method" <<'NODE'
import { readFileSync } from "node:fs";

const [stampPath, expectedMethod] = process.argv.slice(2);
const stamp = JSON.parse(readFileSync(stampPath, "utf8"));
if (stamp.method !== expectedMethod) {
  console.error(`expected ${stampPath} method ${expectedMethod}, got ${String(stamp.method)}`);
  process.exit(1);
}
NODE
}

create_pnpm_shim() {
  local shim_dir="$1"
  local pnpm_version cached_pnpm pnpm_command
  pnpm_version="$(node -e 'const { readFileSync } = require("node:fs"); const pkg = JSON.parse(readFileSync(process.argv[1], "utf8")); console.log(String(pkg.packageManager).replace(/^pnpm@/, ""));' "$ROOT/package.json")"
  cached_pnpm="$HOST_HOME/.cache/node/corepack/v1/pnpm/$pnpm_version/bin/pnpm.cjs"
  pnpm_command="$(command -v pnpm || true)"

  mkdir -p "$shim_dir"
  if [ -f "$cached_pnpm" ]; then
    cat > "$shim_dir/pnpm" <<SHIM
#!/usr/bin/env bash
exec node "$(printf '%s' "$cached_pnpm")" "\$@"
SHIM
    chmod +x "$shim_dir/pnpm"
    return 0
  fi

  if [ -n "$pnpm_command" ]; then
    cat > "$shim_dir/pnpm" <<SHIM
#!/usr/bin/env bash
exec "$(printf '%s' "$pnpm_command")" "\$@"
SHIM
    chmod +x "$shim_dir/pnpm"
    return 0
  fi

  die "cached pnpm $pnpm_version is required for source install validation at $cached_pnpm"
}

CURRENT_BRANCH="$(git -C "$ROOT" branch --show-current)"
[ -n "$CURRENT_BRANCH" ] || die "could not determine current branch"

TMP_ROOT="$(mktemp -d)"
PNPM_SHIM_DIR="$TMP_ROOT/pnpm-shim"
create_pnpm_shim "$PNPM_SHIM_DIR"

echo "==> Source installer validation"
MANAGED_HOME="$TMP_ROOT/managed-home"
MANAGED_INSTALL="$TMP_ROOT/managed-install/estacoda"
mkdir -p "$MANAGED_HOME"

PATH="$PNPM_SHIM_DIR:$PATH" HOME="$MANAGED_HOME" bash "$ROOT/scripts/install.sh" --help >/dev/null
ESTACODA_SOURCE_URL="$ROOT" PATH="$PNPM_SHIM_DIR:$PATH" HOME="$MANAGED_HOME" bash "$ROOT/scripts/install.sh" \
  --dir "$MANAGED_INSTALL" \
  --branch "$CURRENT_BRANCH"

test -f "$MANAGED_INSTALL/.install-method.json"
assert_stamp_method "$MANAGED_INSTALL/.install-method.json" "managed-source"
test ! -e "$MANAGED_HOME/.estacoda"
PATH="$PNPM_SHIM_DIR:$PATH" HOME="$MANAGED_HOME" "$MANAGED_HOME/.local/bin/estacoda" --version
PATH="$PNPM_SHIM_DIR:$PATH" HOME="$MANAGED_HOME" "$MANAGED_HOME/.local/bin/estacoda" --help >/dev/null

echo "==> Manual source setup validation"
MANUAL_HOME="$TMP_ROOT/manual-home"
MANUAL_REPO="$TMP_ROOT/manual-repo/estacoda"
mkdir -p "$MANUAL_HOME" "$(dirname "$MANUAL_REPO")"

git clone --branch "$CURRENT_BRANCH" "$ROOT" "$MANUAL_REPO"
(
  cd "$MANUAL_REPO"
  PATH="$PNPM_SHIM_DIR:$PATH" HOME="$MANUAL_HOME" bash scripts/setup-estacoda.sh --help >/dev/null
  PATH="$PNPM_SHIM_DIR:$PATH" HOME="$MANUAL_HOME" bash scripts/setup-estacoda.sh
  test -f .install-method.json
  assert_stamp_method "$MANUAL_REPO/.install-method.json" "manual-source"
  test ! -e "$MANUAL_HOME/.estacoda"
  PATH="$PNPM_SHIM_DIR:$PATH" HOME="$MANUAL_HOME" "$MANUAL_HOME/.local/bin/estacoda" --version
  PATH="$PNPM_SHIM_DIR:$PATH" HOME="$MANUAL_HOME" "$MANUAL_HOME/.local/bin/estacoda" --help >/dev/null
)

echo "Source installer validation passed."

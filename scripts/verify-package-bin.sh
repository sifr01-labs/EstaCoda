#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT=""
TARBALL=""

cleanup() {
  if [ -n "$TMP_ROOT" ] && [ -d "$TMP_ROOT" ]; then
    rm -rf "$TMP_ROOT"
  fi
  if [ -n "$TARBALL" ] && [ -f "$ROOT/$TARBALL" ]; then
    rm -f "$ROOT/$TARBALL"
  fi
}
trap cleanup EXIT

cd "$ROOT"

pnpm run build

TMP_ROOT="$(mktemp -d)"
TMP_PREFIX="$TMP_ROOT/prefix"
TMP_HOME="$TMP_ROOT/home"
mkdir -p "$TMP_PREFIX" "$TMP_HOME"
export npm_config_cache="$TMP_ROOT/npm-cache"

PACK_JSON="$(npm pack --json)"
TARBALL="$(node --input-type=module -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const parsed = JSON.parse(input);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first || typeof first.filename !== "string" || first.filename.length === 0) {
    throw new Error("npm pack --json did not return a tarball filename");
  }
  const files = Array.isArray(first.files) ? first.files.map((entry) => entry.path) : [];
  const fileSet = new Set(files);
  const requiredFiles = [
    "dist/index.js",
    "scripts/install.sh",
    "scripts/estacoda-wrapper.sh",
    "README.md",
    "LICENSE",
    "NOTICE",
    "CHANGELOG.md",
    "package.json"
  ];
  const requiredRoots = [
    "skills/",
    "assets/",
    "workers/",
    "memory/default/",
    "acp_registry/"
  ];
  const missing = [
    ...requiredFiles.filter((path) => !fileSet.has(path)),
    ...requiredRoots.filter((root) => !files.some((path) => path.startsWith(root)))
  ];
  const forbidden = files.filter((path) => {
    return path === "src" ||
      path.startsWith("src/") ||
      path.startsWith("dist/test/") ||
      path.endsWith(".test.js") ||
      path.endsWith(".test.js.map") ||
      path === ".env" ||
      path.endsWith("/.env") ||
      path === ".estacoda" ||
      path.startsWith(".estacoda/") ||
      path === "logs" ||
      path.startsWith("logs/") ||
      path.includes("/logs/") ||
      path.endsWith(".log");
  });
  if (missing.length > 0 || forbidden.length > 0) {
    if (missing.length > 0) {
      console.error(`npm pack is missing required package entries:\n${missing.join("\n")}`);
    }
    if (forbidden.length > 0) {
      console.error(`npm pack includes forbidden package entries:\n${forbidden.join("\n")}`);
    }
    process.exit(1);
  }
  console.log(first.filename);
});
' <<< "$PACK_JSON")"

if [ ! -f "$TARBALL" ]; then
  echo "Packed tarball not found: $TARBALL" >&2
  exit 1
fi

HOME="$TMP_HOME" npm install -g "./$TARBALL" --prefix "$TMP_PREFIX"

BIN="$TMP_PREFIX/bin/estacoda"
if [ ! -x "$BIN" ]; then
  echo "Installed estacoda binary is missing or not executable: $BIN" >&2
  exit 1
fi

HOME="$TMP_HOME" "$BIN" --version
HOME="$TMP_HOME" "$BIN" --help

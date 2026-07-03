#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT=""
TARBALL=""

cleanup_package_tarballs() {
  local package_tarball
  for package_tarball in "$ROOT"/estacoda-*.tgz; do
    if [ -e "$package_tarball" ]; then
      rm -f -- "$package_tarball"
    fi
  done
}

cleanup() {
  if [ -n "$TMP_ROOT" ] && [ -d "$TMP_ROOT" ]; then
    rm -rf "$TMP_ROOT"
  fi
  cleanup_package_tarballs
}
trap cleanup EXIT

cd "$ROOT"
cleanup_package_tarballs

pnpm run build

TMP_ROOT="$(mktemp -d)"
TMP_PREFIX="$TMP_ROOT/prefix"
TMP_HOME="$TMP_ROOT/home"
mkdir -p "$TMP_PREFIX" "$TMP_HOME"
export npm_config_cache="$TMP_ROOT/npm-cache"

PACK_JSON="$(npm pack --json)"
TARBALL="$(node --input-type=module -e '
import { readFileSync } from "node:fs";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const parsed = JSON.parse(input);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first || typeof first.filename !== "string" || first.filename.length === 0) {
    throw new Error("npm pack --json did not return a tarball filename");
  }
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const metadataFailures = [];
  if (pkg.name !== "estacoda") {
    metadataFailures.push(`expected package name estacoda, got ${String(pkg.name)}`);
  }
  if (pkg.private !== false) {
    metadataFailures.push("expected private: false for npm publish readiness");
  }
  if (pkg.bin?.estacoda !== "./dist/index.js") {
    metadataFailures.push("expected bin.estacoda to point to ./dist/index.js");
  }
  if (pkg.publishConfig?.access !== "public") {
    metadataFailures.push("expected publishConfig.access to be public");
  }
  if (pkg.repository?.type !== "git" || pkg.repository?.url !== "git+https://github.com/sifr01-labs/EstaCoda.git") {
    metadataFailures.push("expected repository metadata for sifr01-labs/EstaCoda");
  }
  if (pkg.bugs?.url !== "https://github.com/sifr01-labs/EstaCoda/issues") {
    metadataFailures.push("expected bugs.url to point at GitHub issues");
  }
  if (pkg.homepage !== "https://estacoda.kemetresearch.com") {
    metadataFailures.push("expected homepage to point at estacoda.kemetresearch.com");
  }
  const rootDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  for (const dependency of ["@whiskeysockets/baileys", "@hapi/boom"]) {
    if (dependency in rootDeps) {
      metadataFailures.push(`expected ${dependency} to stay out of the root dependency tree`);
    }
  }
  const files = Array.isArray(first.files) ? first.files.map((entry) => entry.path) : [];
  const fileSet = new Set(files);
  const requiredFiles = [
    "dist/index.js",
    "scripts/install.sh",
    "scripts/setup-estacoda.sh",
    "scripts/uninstall.sh",
    "scripts/estacoda-wrapper.sh",
    "scripts/whatsapp-bridge/package.json",
    "scripts/whatsapp-bridge/package-lock.json",
    "scripts/whatsapp-bridge/bridge.js",
    "scripts/whatsapp-bridge/README.md",
    "README.md",
    "LICENSE",
    "NOTICE",
    "package.json"
  ];
  const requiredRoots = [
    "skills/",
    "assets/",
    "workers/",
    "acp_registry/"
  ];
  const missing = [
    ...requiredFiles.filter((path) => !fileSet.has(path)),
    ...requiredRoots.filter((root) => !files.some((path) => path.startsWith(root)))
  ];
  const forbidden = files.filter((path) => {
    return path === "src" ||
      path.startsWith("src/") ||
      path === "website" ||
      path.startsWith("website/") ||
      path === "scripts/whatsapp-bridge/node_modules" ||
      path.startsWith("scripts/whatsapp-bridge/node_modules/") ||
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
  if (metadataFailures.length > 0 || missing.length > 0 || forbidden.length > 0) {
    if (metadataFailures.length > 0) {
      console.error(`npm package metadata has publish-readiness regressions:\n${metadataFailures.join("\n")}`);
    }
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

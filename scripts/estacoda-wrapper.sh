#!/usr/bin/env bash
set -euo pipefail

# EstaCoda Node/dist wrapper.
# Used when no prebuilt binary is available for the current platform.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENTRYPOINT="$REPO_ROOT/dist/index.js"

if [ ! -f "$ENTRYPOINT" ]; then
  echo "EstaCoda dist entrypoint not found: $ENTRYPOINT" >&2
  echo "Run: corepack enable && pnpm install && pnpm run build" >&2
  exit 1
fi

exec node "$ENTRYPOINT" "$@"

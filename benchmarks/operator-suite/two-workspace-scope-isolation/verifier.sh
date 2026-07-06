#!/bin/sh
set -eu
workspace="$1"
grep -q "backend service handles orders" "$workspace/workspace-a/output.txt"
test ! -e "$workspace/workspace-b/output.txt"
grep -q "FRONTEND_PRIVATE_MARKER" "$workspace/workspace-b/private.txt"

#!/bin/sh
set -eu
workspace="$1"
grep -q "recovered after injected terminal failure" "$workspace/recovery.log"
node "$workspace/scripts/check-state.js" "$workspace/recovery.log"

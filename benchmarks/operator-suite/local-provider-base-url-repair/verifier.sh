#!/bin/sh
set -eu
workspace="$1"
node "$workspace/scripts/verify-local-provider.js" "$workspace/config/local-provider.json"

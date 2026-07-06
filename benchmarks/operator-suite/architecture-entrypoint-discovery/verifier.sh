#!/bin/sh
set -eu
workspace="$1"
test -f "$workspace/src/server.js"
test -f "$workspace/src/router.js"
test -f "$workspace/src/services/orders.js"

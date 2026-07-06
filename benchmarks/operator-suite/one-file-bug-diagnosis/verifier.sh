#!/bin/sh
set -eu
workspace="$1"
node "$workspace/test/totals.test.js"

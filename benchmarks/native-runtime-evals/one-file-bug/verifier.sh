#!/usr/bin/env sh
set -eu

workspace="${1:-.}"
cd "$workspace"
node test/totals.test.js

#!/usr/bin/env sh
set -eu

workspace="${1:-.}"
status_file="$workspace/reports/status.md"

grep -q "NORTHSTAR" "$status_file"
grep -q "^- Codename:" "$status_file"
if grep -q "LEGACY" "$status_file"; then
  exit 1
fi

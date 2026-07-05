#!/usr/bin/env sh
set -eu

workspace="${1:-.}"
target="${workspace%/}/answer.txt"
expected="benchmark smoke passed"

test -f "$target"
actual="$(cat "$target")"
test "$actual" = "$expected"

#!/usr/bin/env bash
set -euo pipefail

PATTERNS_FILE="bin/pre-commit-redact-patterns.txt"
if [[ ! -f "$PATTERNS_FILE" ]]; then
  echo "[pre-commit] WARNING: no patterns file at $PATTERNS_FILE — skipping leak check"
  exit 0
fi

PATTERNS=$(grep -Ev '^\s*(#|$)' "$PATTERNS_FILE" | paste -sd '|' -)

LEAK=$(git diff --cached --unified=0 -- ':!bin/pre-commit*' ':!docs/superpowers/**' \
  | grep -E '^\+' \
  | grep -Ev '^\+\+\+' \
  | grep -E "$PATTERNS" || true)

if [[ -n "$LEAK" ]]; then
  echo "[pre-commit] possible secrets/IPs in staged changes:" >&2
  echo "$LEAK" >&2
  echo "[pre-commit] update bin/pre-commit-redact-patterns.txt or override with --no-verify if it's a false positive." >&2
  exit 1
fi
exit 0

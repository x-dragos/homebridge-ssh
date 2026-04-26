#!/usr/bin/env bash
set -euo pipefail

if [[ -f .env.local ]]; then
  # shellcheck disable=SC1091
  source .env.local
fi

if [[ -z "${PI_HOST:-}" ]]; then
  echo "ERROR: PI_HOST is not set. Define it in .env.local." >&2
  exit 1
fi

CMD=${1:-uptime}
echo "[test-ssh] $PI_HOST -> $CMD"
ssh "$PI_HOST" "$CMD"

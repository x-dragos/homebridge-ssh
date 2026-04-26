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

ssh "$PI_HOST" bash -lc '
  if command -v hb-service >/dev/null 2>&1; then
    sudo hb-service logs
  elif systemctl list-units --type=service | grep -q homebridge; then
    sudo journalctl -u homebridge -f --no-pager -n 200
  else
    echo "ERROR: could not detect homebridge service manager on this host." >&2
    exit 1
  fi
'

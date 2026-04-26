#!/usr/bin/env bash
set -euo pipefail

if [[ -f .env.local ]]; then
  # shellcheck disable=SC1091
  source .env.local
fi

if [[ -z "${PI_HOST:-}" ]]; then
  echo "ERROR: PI_HOST is not set. Define it in .env.local (e.g. PI_HOST=user@homebridge.local)." >&2
  exit 1
fi

echo "[deploy] verifying + building..."
# `npm pack` triggers `prepack` which runs lint + format + typecheck + test + build.
TARBALL=$(npm pack --silent | tail -n 1)
echo "[deploy] tarball: $TARBALL"

echo "[deploy] copying to $PI_HOST:/tmp/..."
scp -q "$TARBALL" "$PI_HOST:/tmp/"

REMOTE_RESTART_CMD=${PI_RESTART_CMD:-}
TARBALL_BASENAME=$(basename "$TARBALL")
PLUGIN_NAME="homebridge-ssh"

echo "[deploy] installing and restarting on $PI_HOST..."
ssh "$PI_HOST" \
  "TARBALL_BASENAME='$TARBALL_BASENAME' PI_RESTART_CMD='$REMOTE_RESTART_CMD' PLUGIN_NAME='$PLUGIN_NAME' bash -s" \
  <<'REMOTE_EOF'
set -euo pipefail

# Detect Homebridge install layout. Two supported paths:
#  1. homebridge-apt-pkg / official Pi image: plugins extracted into /var/lib/homebridge/node_modules/<plugin>/
#  2. Generic Node + hb-service or systemd: install via `sudo npm install -g <tarball>`.
HB_LIB_DIR=/var/lib/homebridge
HB_NODE=/opt/homebridge/bin/node

if [[ -d "$HB_LIB_DIR" && -x "$HB_NODE" ]]; then
  PLUGIN_DIR="$HB_LIB_DIR/node_modules/$PLUGIN_NAME"
  echo "[remote] homebridge-apt-pkg layout detected"
  echo "[remote] installing plugin to $PLUGIN_DIR"
  sudo rm -rf "$PLUGIN_DIR"
  sudo mkdir -p "$PLUGIN_DIR"
  # The npm tarball contains a top-level 'package/' directory. Strip it so files
  # land directly in PLUGIN_DIR.
  sudo tar -xzf "/tmp/${TARBALL_BASENAME}" -C "$PLUGIN_DIR" --strip-components=1
  if id -u homebridge >/dev/null 2>&1; then
    sudo chown -R homebridge:homebridge "$PLUGIN_DIR"
  fi
  echo "[remote] installed"
else
  # Generic path. Try several npm locations because sudo's PATH usually omits user installs.
  NPM_BIN=""
  for candidate in \
    "$(command -v npm 2>/dev/null || true)" \
    "$(bash -lc 'command -v npm' 2>/dev/null || true)" \
    /opt/homebridge/bin/npm \
    /usr/local/bin/npm \
    /usr/bin/npm; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      NPM_BIN="$candidate"
      break
    fi
  done
  if [[ -z "$NPM_BIN" ]]; then
    echo "[remote] ERROR: npm not found on remote host." >&2
    echo "[remote] Searched: command -v, login-shell PATH, /opt/homebridge/bin, /usr/local/bin, /usr/bin." >&2
    exit 1
  fi
  echo "[remote] installing via $NPM_BIN"
  sudo "$NPM_BIN" install -g "/tmp/${TARBALL_BASENAME}" >/dev/null
fi

# Restart Homebridge — same auto-detection as before.
if [[ -n "${PI_RESTART_CMD}" ]]; then
  echo "[remote] using PI_RESTART_CMD: ${PI_RESTART_CMD}"
  eval "${PI_RESTART_CMD}"
elif command -v hb-service >/dev/null 2>&1; then
  echo "[remote] hb-service detected — restarting"
  sudo hb-service restart
elif systemctl list-units --type=service | grep -q homebridge; then
  echo "[remote] systemd homebridge unit detected — restarting"
  sudo systemctl restart homebridge
else
  echo "[remote] WARNING: could not detect homebridge service manager. Restart manually." >&2
  exit 0
fi

echo "[remote] restart issued"
REMOTE_EOF

rm -f "$TARBALL"
echo "[deploy] done. Tail logs with: npm run logs:pi"

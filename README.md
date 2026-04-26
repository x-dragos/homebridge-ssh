# homebridge-ssh

Expose remote shell scripts as native HomeKit accessories via SSH. Built as a Homebridge dynamic platform plugin.

## Features

- **Switch accessories** (`Service.Switch`) — stateful or momentary auto-reset modes; optional state polling.
- **Garage door accessories** (`Service.GarageDoorOpener`) — synthetic state machine driven by configurable travel times; optional auto-close (plugin-driven or hardware-mirrored); optional state command for drift correction.
- **Multiple hosts** — one persistent SSH connection per host, lazy connect, optional idle disconnect.
- **Three auth methods** — private key (preferred), `ssh-agent`, or password (logged as a startup warning).

## Requirements

- Node.js **20**, **22**, or **24** (Homebridge supported LTS).
- Homebridge **1.8+** or **2.0-beta+**.

## Installation

```bash
sudo npm install -g homebridge-ssh
```

Or install via the Homebridge UI plugin browser.

## Configuration

The Homebridge UI offers a form covering hosts and accessories with conditional fields per type and per auth method. Minimal `config.json` example:

```json
{
  "platform": "HomebridgeSsh",
  "name": "SSH Bridge",
  "logLevel": "info",
  "hosts": [
    {
      "id": "gate-pi",
      "ssh": {
        "host": "192.0.2.20",
        "port": 22,
        "user": "pi",
        "auth": { "method": "key", "privateKeyPath": "/home/homebridge/.ssh/id_ed25519" }
      }
    }
  ],
  "accessories": [
    {
      "type": "garageDoor",
      "name": "Front Gate",
      "host": "gate-pi",
      "commands": {
        "open": { "command": "/usr/local/bin/gate-open.sh", "timeoutMs": 5000 },
        "close": { "command": "/usr/local/bin/gate-close.sh", "timeoutMs": 5000 }
      },
      "timing": {
        "openTravelTimeMs": 15000,
        "closeTravelTimeMs": 15000,
        "autoCloseTimeoutMs": 0,
        "autoCloseMode": "execute",
        "statePollIntervalMs": 0
      }
    },
    {
      "type": "switch",
      "name": "Reboot Gate Pi",
      "host": "gate-pi",
      "commands": { "on": { "command": "sudo /sbin/reboot", "timeoutMs": 5000 } },
      "behavior": { "mode": "momentary", "autoResetMs": 1000 }
    }
  ]
}
```

### Hosts

| Field                     | Default                    | Notes                                                                                                                                                    |
| ------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                      | required                   | Stable identifier referenced by accessories. Lowercase, dashes ok.                                                                                       |
| `ssh.host`                | required                   | Hostname or IP.                                                                                                                                          |
| `ssh.port`                | `22`                       |                                                                                                                                                          |
| `ssh.user`                | required                   |                                                                                                                                                          |
| `ssh.auth.method`         | `key`                      | `key` \| `password` \| `agent`                                                                                                                           |
| `ssh.auth.privateKeyPath` | required for key auth      | Path to OpenSSH private key.                                                                                                                             |
| `ssh.auth.passphrase`     | `""`                       | For encrypted keys.                                                                                                                                      |
| `ssh.auth.password`       | required for password auth | **Plaintext — prefer `key` or `agent`.**                                                                                                                 |
| `ssh.connectTimeoutMs`    | `10000`                    |                                                                                                                                                          |
| `ssh.keepaliveIntervalMs` | `30000`                    |                                                                                                                                                          |
| `ssh.idleDisconnectMs`    | `0`                        | `0` = never disconnect (default for always-on hosts). `> 0` = close the SSH connection after that many ms idle and reconnect lazily on the next command. |

### Switch accessory

| Field                  | Notes                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `commands.on`          | Required — runs on turn-on.                                                                                                        |
| `commands.off`         | Optional — runs on turn-off in stateful mode. Warned (and ignored) if set in momentary mode.                                       |
| `behavior.mode`        | `stateful` (default) or `momentary`.                                                                                               |
| `behavior.autoResetMs` | Required for momentary; default `1000`. After running the on-command, HomeKit's switch state flips back to off after this many ms. |
| `state.command`        | Optional — periodically polled to push the real on/off state into HomeKit.                                                         |
| `state.onValue`        | String to detect "on" in stdout.                                                                                                   |
| `state.matchMode`      | `exact` (default), `contains`, or `regex`.                                                                                         |
| `state.pollIntervalMs` | `0` to disable polling.                                                                                                            |

### Garage door accessory

| Field                        | Notes                                                                                                                                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commands.open`              | Required.                                                                                                                                                                                                      |
| `commands.close`             | Required.                                                                                                                                                                                                      |
| `commands.state`             | Optional — polled to reconcile real state with the plugin's tracked state.                                                                                                                                     |
| `stateMapping`               | Required if `commands.state` is set. `open` and `closed` rules required; `opening`/`closing` optional.                                                                                                         |
| `timing.openTravelTimeMs`    | How long the gate physically takes to open; `0` for immediate settle.                                                                                                                                          |
| `timing.closeTravelTimeMs`   | Symmetric.                                                                                                                                                                                                     |
| `timing.autoCloseTimeoutMs`  | Auto-close N ms after settling to OPEN. `0` disables.                                                                                                                                                          |
| `timing.autoCloseMode`       | `execute` (default — plugin runs the close command after the timeout, for gates that don't auto-close themselves) or `simulated` (plugin only updates state, for gates whose hardware physically auto-closes). |
| `timing.statePollIntervalMs` | Poll interval in ms (`0` = no polling).                                                                                                                                                                        |

#### State machine

- `TargetDoorState = Open` → `Opening` → run `commands.open` → after `openTravelTimeMs`, `Open`. If `autoCloseTimeoutMs > 0`, schedule the close cycle (run command in `execute` mode, simulate transitions in `simulated` mode).
- `TargetDoorState = Closed` mirrors with the close command.
- A new target during motion cancels in-flight settle and auto-close timers and starts the new transition.
- A failed command rolls back to the **last stable state** (Open or Closed), throws `SERVICE_COMMUNICATION_FAILURE` to HomeKit, and logs the reason. The orchestrator never wedges on a motion state.
- When `commands.state` is configured, every `statePollIntervalMs` the parser maps stdout to a state; if it disagrees with the plugin's tracked state, the plugin reconciles and cancels stale timers.

## Examples

[`examples/`](examples/) contains reference scripts the plugin can invoke over SSH, including a Raspberry Pi GPIO garage-door driver that implements the state-file convention used by `commands.state`.

## Local development

This codebase is developed on a Mac. Homebridge runs on Pi A; user scripts run wherever (could be the same Pi or a separate one reachable via SSH).

- **Tests on Mac**: `npm test` (vitest). Domain logic is fully covered with fakes — no SSH, no Homebridge, no Pi required.
- **Deploy to Pi**: `npm run deploy:pi` runs `prepack` (lint + format + typecheck + test + build), packs, scps to `$PI_HOST` (from `.env.local`), installs runtime deps, restarts Homebridge (auto-detects `hb-service` or `systemctl`).
- **Tail logs from Mac**: `npm run logs:pi`.
- **Quick SSH check**: `npm run test:ssh -- "uptime"`.

### First-time setup

```bash
git clone <repo>
cd homebridge-ssh
npm install
npx simple-git-hooks                    # install the pre-commit secret-scan hook
cp .env.example .env.local              # then edit with your PI_HOST, etc.
npm test                                # verify your install works
```

## License

Apache-2.0.

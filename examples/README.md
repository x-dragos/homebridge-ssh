# Examples

Reference implementations of the remote scripts that `homebridge-ssh` invokes over SSH. They are not bundled with the npm tarball — copy whichever fits your installation onto the remote host and adapt it.

## Garage door — Raspberry Pi GPIO

[`scripts/garage-door-gpio.py`](scripts/garage-door-gpio.py) drives a two-relay opener (one relay pulses to open, another to close) and exposes an `open` / `close` / `state` CLI that pairs with `commands.open` / `commands.close` / `commands.state` in the plugin's accessory config.

It implements the **state-file convention** the plugin expects when `commands.state` is configured: every transition writes `OPENING`, `OPEN`, `CLOSING`, or `CLOSED` to a file, the `state` subcommand prints whatever the file contains, and a background worker fires the timed transitions so the SSH command returns immediately. A new `open` or `close` invocation kills any in-flight worker so the file always reflects the latest user (or hardware) intent.

The corresponding accessory config:

```json
{
  "type": "garageDoor",
  "name": "Garage",
  "host": "<host-id>",
  "commands": {
    "open": { "command": "sudo /usr/local/bin/garage-door open" },
    "close": { "command": "sudo /usr/local/bin/garage-door close" },
    "state": { "command": "/usr/local/bin/garage-door state" }
  },
  "stateMapping": {
    "open": { "match": "OPEN", "mode": "exact" },
    "closed": { "match": "CLOSED", "mode": "exact" },
    "opening": { "match": "OPENING", "mode": "exact" },
    "closing": { "match": "CLOSING", "mode": "exact" }
  },
  "timing": { "openTravelTimeMs": 20000, "closeTravelTimeMs": 20000 }
}
```

### Install

```bash
sudo install -m 755 garage-door-gpio.py /usr/local/bin/garage-door
sudo apt install -y python3-rpi.gpio   # only if missing
```

### Adapt

The constants at the top of the script (`OPEN_PIN`, `CLOSE_PIN`, `TRAVEL_SECONDS`, `AUTOCLOSE_SECONDS`) are all the customisation most installations need. Set `AUTOCLOSE_SECONDS = 0` for doors that do not auto-close on their own and let the plugin run the close command via the `autoCloseMode: "execute"` setting instead.

### Sudoers

If the `open` and `close` invocations need root for GPIO access, allow them passwordlessly:

```
<your-user> ALL=(ALL) NOPASSWD: /usr/local/bin/garage-door open, /usr/local/bin/garage-door close
```

`state` only reads a file and does not need sudo.

## State-file convention (writing your own script)

Whatever language or hardware you use, the plugin only cares that the script's `state` subcommand prints a value matching one of the rules in `stateMapping`. The reference script writes:

| Trigger                            | File contents                           |
| ---------------------------------- | --------------------------------------- |
| `open` invoked                     | `OPENING\n` immediately                 |
| Door finished opening              | `OPEN\n` after travel time              |
| Auto-close started (hardware-side) | `CLOSING\n` after the auto-close window |
| `close` invoked, or close finished | `CLOSED\n` after travel time            |

Any unique substring works as long as the `stateMapping.<state>.match` value matches it. The plugin trims trailing whitespace before matching.

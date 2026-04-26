#!/usr/bin/env python3
"""Reference implementation of a homebridge-ssh-platform garage-door driver.

A two-relay GPIO opener that pulses one relay for "open" and another for "close".
Mirrors the door's state in /tmp/<DEVICE_NAME>.state so the plugin's `commands.state`
poll can confirm the door's actual position.

This script is the example referenced by the plugin's state-mapping configuration:

    {
      "type": "garageDoor",
      "name": "Garage",
      "host": "<host-id>",
      "commands": {
        "open":  { "command": "sudo /usr/local/bin/garage-door open"  },
        "close": { "command": "sudo /usr/local/bin/garage-door close" },
        "state": { "command": "/usr/local/bin/garage-door state"      }
      },
      "stateMapping": {
        "open":    { "match": "OPEN",    "mode": "exact" },
        "closed":  { "match": "CLOSED",  "mode": "exact" },
        "opening": { "match": "OPENING", "mode": "exact" },
        "closing": { "match": "CLOSING", "mode": "exact" }
      }
    }

Run as the user that has access to the GPIO pins (typically root via sudo, or the
`gpio` group on Raspberry Pi). The `state` subcommand only reads the file, so it
does not need elevated privileges.

State transitions written to STATE_FILE:
    OPENING -> immediately on `open`
    OPEN    -> after TRAVEL_SECONDS (door finished opening)
    CLOSING -> after AUTOCLOSE_SECONDS (hardware-side auto-close starts)
                OR immediately on a manual `close`
    CLOSED  -> after TRAVEL_SECONDS following CLOSING

A background worker process drives the timed transitions. Subsequent open/close
invocations cancel any pending worker so the state file always reflects the
latest user (or hardware) intent.

Adapt the constants in the configuration block below for your installation.
"""

import os
import signal
import sys
from time import sleep

import RPi.GPIO as GPIO

# ----- configuration ---------------------------------------------------------
DEVICE_NAME = "garage-door"
STATE_FILE = f"/tmp/{DEVICE_NAME}.state"
PID_FILE = f"/tmp/{DEVICE_NAME}.pid"

# Pulse pins: which BCM-numbered GPIO pin drives each relay.
OPEN_PIN = 23
CLOSE_PIN = 24
PULSE_SECONDS = 0.5

# Travel time the physical door takes to fully open or close.
TRAVEL_SECONDS = 20

# If the hardware auto-closes the door after a set time, mirror that here.
# Set to 0 if the door does NOT auto-close on its own.
AUTOCLOSE_SECONDS = 0
# -----------------------------------------------------------------------------


def write_state(s):
    try:
        with open(STATE_FILE, "w") as f:
            f.write(s + "\n")
    except IOError:
        pass


def read_state():
    try:
        with open(STATE_FILE) as f:
            return f.read()
    except IOError:
        return "UNKNOWN\n"


def write_pid(pid):
    try:
        with open(PID_FILE, "w") as f:
            f.write(str(pid) + "\n")
    except IOError:
        pass


def kill_pending():
    """Stop any in-flight background worker from a prior invocation. PID-reuse safe."""
    try:
        with open(PID_FILE) as f:
            pid = int(f.read().strip())
    except (IOError, ValueError):
        return
    try:
        with open("/proc/%d/cmdline" % pid) as f:
            cmdline = f.read()
    except IOError:
        return  # process is gone
    if DEVICE_NAME not in cmdline:
        return  # PID was reused — do not touch
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass


def pulse(pin):
    GPIO.setmode(GPIO.BCM)
    GPIO.setwarnings(False)
    GPIO.setup(pin, GPIO.OUT)
    GPIO.output(pin, False)
    GPIO.output(pin, True)
    sleep(PULSE_SECONDS)
    GPIO.output(pin, False)


def detach():
    """Detach from the SSH session so the parent can return immediately."""
    os.setsid()
    devnull = open(os.devnull, "w")
    os.dup2(devnull.fileno(), sys.stdout.fileno())
    os.dup2(devnull.fileno(), sys.stderr.fileno())


def fork_to_background():
    """Returns True in the parent (must return), False in the child (continues)."""
    pid = os.fork()
    if pid != 0:
        write_pid(pid)
        return True
    detach()
    return False


def open_cycle():
    sleep(TRAVEL_SECONDS)
    write_state("OPEN")
    if AUTOCLOSE_SECONDS > 0:
        sleep(AUTOCLOSE_SECONDS)
        write_state("CLOSING")
        sleep(TRAVEL_SECONDS)
        write_state("CLOSED")


def close_cycle():
    sleep(TRAVEL_SECONDS)
    write_state("CLOSED")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else None
    if cmd == "open":
        kill_pending()
        write_state("OPENING")
        pulse(OPEN_PIN)
        if fork_to_background():
            return
        try:
            open_cycle()
        finally:
            os._exit(0)
    elif cmd == "close":
        kill_pending()
        write_state("CLOSING")
        pulse(CLOSE_PIN)
        if fork_to_background():
            return
        try:
            close_cycle()
        finally:
            os._exit(0)
    elif cmd == "state":
        sys.stdout.write(read_state())
    else:
        sys.stderr.write(f"usage: {DEVICE_NAME} {{open|close|state}}\n")
        sys.exit(2)


if __name__ == "__main__":
    main()

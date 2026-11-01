#!/bin/bash
# Real-pi smoke for R4-06 / F4-01: abort a call whose channel is still starting, in a real pi session.
#
# `pi -p` cannot do this: SIGINT there is a hard kill that runs no session_shutdown and fires no abort
# (measured: an idle daemon survives SIGINT and is only closed by a clean exit). So this drives the real
# interactive TUI under a pty and presses Esc with a byte, the way a user does.
#
# Usage: PI_CODING_AGENT_DIR=/tmp/pi-smoke-agent7 bash scripts/smoke-abort-start.sh
set -u
: "${PI_CODING_AGENT_DIR:?set PI_CODING_AGENT_DIR to a throwaway agent dir}"

CHANNEL="smoke-abort"
STUB_ENV="${STUB_ENV:-/tmp/pi-smoke-env-slow}"
READY_TIMEOUT_MS="${READY_TIMEOUT_MS:-60000}"
PIDFILE=/tmp/pi-smoke-abort-start.pid
rm -f "$PIDFILE" /tmp/pi-smoke-abort-ran.txt

# The slow interpreter: an environment directory that already looks complete, whose `bin/python`
# sleeps long enough that the call is still waiting for `ready` when Esc arrives. Built here so the
# script is one command; a real environment would come from ~/.cache/pi-replmode.
if [ ! -x "$STUB_ENV/bin/python" ]; then
  REAL_PYTHON=$(ls -1 "$HOME"/.cache/pi-replmode/py-env-*/bin/python 2>/dev/null | head -1)
  [ -n "$REAL_PYTHON" ] || REAL_PYTHON=$(command -v python3)
  mkdir -p "$STUB_ENV/bin"
  printf '#!/bin/sh\nsleep 25\nexec %s "$@"\n' "$REAL_PYTHON" > "$STUB_ENV/bin/python"
  chmod +x "$STUB_ENV/bin/python"
  : > "$STUB_ENV/.complete"
  echo "built a slow stub interpreter at $STUB_ENV (execs $REAL_PYTHON after 25s)"
fi

export PI_REPLMODE_ENV_DIR="$STUB_ENV" PI_REPLMODE_READY_TIMEOUT_MS="$READY_TIMEOUT_MS"
export PI_SMOKE_PIDFILE="$PIDFILE"

prompt='Use the run tool exactly once, with channel "smoke-abort" and code: open("/tmp/pi-smoke-abort-ran.txt","w").write("ran"). Then tell me what it said.'

# The TUI: type the prompt, Enter, then Esc once the daemon is up.
{
  sleep 2
  printf '%s' "$prompt"
  sleep 0.4
  printf '\r'
  # Wait for the daemon to exist, then press Esc.
  for i in $(seq 1 120); do
    if pgrep -f "channel=$CHANNEL" >/dev/null 2>&1; then break; fi
    sleep 0.5
  done
  sleep 1
  printf '\033'          # Esc: the user's abort
  sleep 6
  printf '\033'          # Esc again so the TUI is idle
  sleep 1
  printf '/exit\r'       # a clean end, so session_shutdown runs for anything left
  sleep 3
} | script -qec "pi --no-builtin-tools" /dev/null > /tmp/smoke-abort-tui.log 2>&1

echo "=== daemon after Esc:"
LEFT=$(pgrep -af "channel=$CHANNEL" | grep -v "script -qec" || true)
if [ -n "$LEFT" ]; then echo "STILL RUNNING: $LEFT"; else echo "none — the aborted start closed its daemon"; fi
echo "=== did the cell run?"
ls -la /tmp/pi-smoke-abort-ran.txt 2>&1 || true
echo "=== tail of the TUI log:"
tail -c 1500 /tmp/smoke-abort-tui.log

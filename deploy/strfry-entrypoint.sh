#!/usr/bin/env bash
# PactAgent Strfry entrypoint (Issue #39 B39-01).
#
# The upstream wrapper runs as PID 1, backgrounds Strfry, and traps EXIT with
# `kill -- -$$`. As PID 1 that expands to the special `kill -1` broadcast.
# Directly exec'ing Strfry is also insufficient here: its SIGTERM-derived exit
# status 143 leaves Railway's persistent-volume restart handoff stuck. This
# wrapper forwards SIGTERM to exactly one child, waits a bounded interval, then
# returns a controlled retryable status after an intentional platform restart.
# Unexpected child failures still propagate their original status to Railway.
set -Eeuo pipefail

CONFIG=/etc/strfry.conf

if [ ! -f "$CONFIG" ]; then
  echo "Strfry configuration is missing at $CONFIG — refusing to start" >&2
  exit 1
fi

if [ ! -x /app/strfry ]; then
  echo "Strfry binary is missing at /app/strfry — refusing to start" >&2
  exit 1
fi

cd /app
echo "strfry entrypoint starting (pid $$)"

child_pid=""

shutdown() {
  trap - TERM INT
  echo "strfry entrypoint stopping after platform signal"

  if [ -z "$child_pid" ]; then
    exit 75
  fi

  kill -TERM "$child_pid" 2>/dev/null || true

  # Strfry normally exits in under a second. Bound the wait so a wedged child
  # cannot hold the Railway volume indefinitely during an explicit restart.
  for ((attempt = 0; attempt < 100; attempt += 1)); do
    if ! kill -0 "$child_pid" 2>/dev/null; then
      wait "$child_pid" 2>/dev/null || true
      echo "strfry entrypoint stopped cleanly"
      exit 75
    fi
    sleep 0.1
  done

  echo "strfry did not stop within 10 seconds; forcing shutdown" >&2
  kill -KILL "$child_pid" 2>/dev/null || true
  wait "$child_pid" 2>/dev/null || true
  exit 75
}

trap shutdown TERM INT

/app/strfry relay &
child_pid=$!

if wait "$child_pid"; then
  child_status=0
else
  child_status=$?
fi

exit "$child_status"

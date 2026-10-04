#!/usr/bin/env bash
# PactAgent Strfry entrypoint (Issue #39 B39-01).
#
# The upstream wrapper runs as PID 1, backgrounds Strfry, and traps EXIT with
# `kill -- -$$`. As PID 1 that expands to the special `kill -1` broadcast and
# prevents a reliable Railway restart handoff. This entrypoint validates the
# immutable inputs, then execs Strfry so it becomes PID 1 and receives SIGTERM
# directly. Unexpected failures are bounded by Railway's ON_FAILURE policy.
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
exec /app/strfry relay

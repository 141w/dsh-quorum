#!/usr/bin/env bash
# Start a dsh web profile and print the one URL that actually works.
#
# Why this exists: the token is printed once at startup, and a token from a previous
# process is dead -- a stale token returns HTTP 401, and the page then looks broken
# rather than unauthorized. Reusing a token recovered from a rotated log cost one
# debugging round, so this always starts a fresh server and reads the URL it prints.
#
# Usage: .probe/serve.sh <profile> [port]
set -euo pipefail

PROFILE="${1:?usage: .probe/serve.sh <profile> [port]}"
PORT="${2:-3097}"
LOG="/tmp/dsh-${PROFILE}-${PORT}.log"

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  HOLDER=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t | head -1)
  echo "port $PORT is held by pid $HOLDER -- stopping it first"
  kill "$HOLDER"
  for _ in $(seq 1 20); do
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
    sleep 0.5
  done
fi

: > "$LOG"
nohup dsh --profile "$PROFILE" --port "$PORT" --no-open > "$LOG" 2>&1 &
PID=$!

URL=""
for _ in $(seq 1 60); do
  URL=$(grep -o "http://127\.0\.0\.1:${PORT}/?token=[A-Za-z0-9_-]*" "$LOG" 2>/dev/null | head -1 || true)
  [ -n "$URL" ] && break
  if grep -q "startup failed" "$LOG" 2>/dev/null; then
    echo "startup failed:"; cat "$LOG"; exit 1
  fi
  sleep 0.5
done

if [ -z "$URL" ]; then
  echo "no URL after 30s; log follows:"; cat "$LOG"; exit 1
fi

# A pending row means a bundle is waiting for a service it will never get, which for
# this plugin means it silently never activates -- the exact failure D7 documents.
if grep -q "pending (waiting for service" "$LOG" 2>/dev/null; then
  echo "WARNING: something is pending, so it is not activated:"
  grep "pending (waiting for service" "$LOG"
fi

echo "profile: $PROFILE   pid: $PID   log: $LOG"
echo "URL: $URL"

#!/bin/sh
set -eu

Xvfb "${DEEPINFRA_DISPLAY:-:99}" -screen 0 1280x1024x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!
trap 'kill "$XVFB_PID" 2>/dev/null || true' EXIT INT TERM
sleep 2

exec node .output/server/index.mjs

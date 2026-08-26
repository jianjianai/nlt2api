#!/bin/sh
set -eu

# The Turnstile challenge rejects headless mode and needs a real rendering
# pipeline, so a headless host must provide a virtual display.
Xvfb "${MINTER_DISPLAY:-:99}" -screen 0 1280x1024x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!
trap 'kill "$XVFB_PID" 2>/dev/null || true' EXIT INT TERM
sleep 2

exec node --experimental-transform-types src/main.ts

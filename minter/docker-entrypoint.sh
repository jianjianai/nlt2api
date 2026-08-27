#!/bin/sh
set -eu

# The Turnstile challenge rejects headless mode and needs a real rendering
# pipeline, so a headless host must provide a virtual display.
# A previous run may have left a stale lock behind after a crash/restart.
DISPLAY_NUM="${MINTER_DISPLAY:-:99}"
LOCK="/tmp/.X${DISPLAY_NUM#:}-lock"
rm -f "$LOCK"

# Chromium needs a writable HOME for its crashpad database and per-user config.
# The container may inherit a Windows-style HOME (C:\Users\...) from the host,
# which makes the browser crash with SIGTRAP at startup. Also, HOME must not
# point at a volume mount (/app/.data is a separate ext4 device): the Debian
# chromium build crashes when the crashpad database and the user-data-dir live
# on different filesystems. /tmp is on the rootfs and always writable.
export HOME="/tmp"

Xvfb "$DISPLAY_NUM" -screen 0 1280x1024x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!
trap 'kill "$XVFB_PID" 2>/dev/null || true' EXIT INT TERM

# Wait until Xvfb actually accepts connections; fail fast with the log when it
# does not, instead of running without a display and minting zero tickets.
i=0
while [ "$i" -lt 20 ]; do
  if kill -0 "$XVFB_PID" 2>/dev/null && [ -S "/tmp/.X11-unix/X${DISPLAY_NUM#:}" ]; then
    break
  fi
  i=$((i + 1))
  sleep 0.25
done
if ! kill -0 "$XVFB_PID" 2>/dev/null || [ ! -S "/tmp/.X11-unix/X${DISPLAY_NUM#:}" ]; then
  echo "Xvfb failed to start on ${DISPLAY_NUM}; log follows:" >&2
  cat /tmp/xvfb.log >&2 || true
  exit 1
fi

exec node --experimental-transform-types src/main.ts

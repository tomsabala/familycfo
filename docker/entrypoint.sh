#!/bin/sh
set -e
mkdir -p "$(dirname "$BANK_DB")" "$POLICIES_DIR" "$REPORTS_DIR"

# Headful Chromium under a virtual display: the scrapers are run with showBrowser on, because some
# banks refuse a headless login (README "Troubleshooting"). SHOW_BROWSER=0 in the instance env file
# switches to headless without rebuilding.
#
# Xvfb is started here rather than through `xvfb-run`: that script waits for Xvfb's SIGUSR1 before
# exec'ing the command, and as PID 1 it never receives it — Xvfb comes up and the server never
# starts. Doing it by hand also leaves node as PID 1, so `docker stop` reaches it directly.
rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp >/dev/null 2>&1 &
export DISPLAY=:99

exec node dist/server/index.js

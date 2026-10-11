#!/usr/bin/env bash
# Launch iRig Lab: enable the iRig HD input in PipeWire, serve the app on localhost
# (microphone access requires a secure context) and open it in a Chromium app window.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-8765}"

# PipeWire leaves the iRig HD on the "off" profile; its only input profile is pro-audio.
CARD="$(pactl list short cards 2>/dev/null | awk '/iRig/ {print $2; exit}')"
if [ -n "$CARD" ]; then
  pactl set-card-profile "$CARD" pro-audio 2>/dev/null || true
else
  echo "Note: iRig HD not found — plug it in (you can still pick another input in the app)."
fi

python3 "$DIR/serve.py" "$PORT" >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 0.5

URL="http://localhost:$PORT/"
BROWSER="$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)"
if [ -n "$BROWSER" ]; then
  # Separate profile so this window owns its process (and remembers the mic permission)
  "$BROWSER" --app="$URL" --user-data-dir="$HOME/.config/irig-lab-browser" \
    --autoplay-policy=no-user-gesture-required --window-size=1400,950 >/dev/null 2>&1
else
  echo "Open $URL in a Chromium-based browser or Firefox. Ctrl+C to stop."
  wait $SERVER
fi

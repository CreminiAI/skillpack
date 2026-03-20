#!/bin/bash
cd "$(dirname "$0")"

# Read the pack name
PACK_NAME="Skills Pack"
if [ -f "skillpack.json" ] && command -v node &> /dev/null; then
  PACK_NAME=$(node -e "console.log(JSON.parse(require('fs').readFileSync('skillpack.json','utf-8')).name)" 2>/dev/null || echo "Skills Pack")
fi

echo ""
echo "  Starting ${PACK_NAME}..."
echo ""

# Install dependencies
if [ ! -d "server/node_modules" ]; then
  echo "  Installing dependencies..."
  cd server && npm install --omit=dev && cd ..
  echo ""
fi

# First-run flag (controls browser auto-open on first launch only)
FIRST_RUN=1

while true; do
  SKILLPACK_FIRST_RUN="$FIRST_RUN" \
  PACK_ROOT="$(pwd)" \
  NODE_ENV="production" \
    node server/dist/index.js
  EXIT_CODE=$?

  FIRST_RUN=0

  # Only restart on exit code 75 (/restart command)
  if [ "$EXIT_CODE" -eq 75 ]; then
    echo ""
    echo "  Restarting..."
    sleep 1
    continue
  fi

  # All other exit codes (0, 64, crash, Ctrl+C, kill, etc.) → stop
  if [ "$EXIT_CODE" -eq 64 ]; then
    echo ""
    echo "  Shutdown complete."
  elif [ "$EXIT_CODE" -ne 0 ]; then
    echo ""
    echo "  Process exited with code $EXIT_CODE."
  fi
  break
done

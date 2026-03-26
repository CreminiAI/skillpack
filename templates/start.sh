#!/bin/bash
cd "$(dirname "$0")"

# First-run flag (controls browser auto-open on first launch only)
FIRST_RUN=1

while true; do
  SKILLPACK_FIRST_RUN="$FIRST_RUN" \
  PACK_ROOT="$(pwd)" \
    npx -y @cremini/skillpack run .
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

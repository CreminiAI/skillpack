#!/bin/bash
cd "$(dirname "$0")"

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

# Auto-bootstrap tunnel dependencies unless explicitly disabled.
# Set SKIP_TUNNEL_SETUP=1 to skip this step.
if [ "${SKIP_TUNNEL_SETUP:-0}" != "1" ]; then
  if ! have_cmd cloudflared || ! have_cmd ngrok; then
    if [ -x "./install.sh" ]; then
      echo ""
      echo "  Tunnel dependencies missing. Running install.sh..."
      echo ""
      ./install.sh || true
      echo ""
    fi
  fi
fi

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

# Start the server
cd server && node index.js

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

# Start the server
cd server && node index.js

@echo off
cd /d "%~dp0"

echo.
echo   Starting Skills Pack...
echo.

if not exist "server\node_modules" (
  echo   Installing dependencies...
  cd server && npm ci --omit=dev && cd ..
  echo.
)

rem Start the server (port detection and browser launch are handled by server\index.js)
cd server && node index.js

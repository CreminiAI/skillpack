@echo off
cd /d "%~dp0"

echo.
echo   Starting Skills Pack...
echo.

if not exist "server\node_modules\.bin\pm2.cmd" (
  echo   Installing dependencies...
  cd server && npm ci --omit=dev && cd ..
  echo.
)

set "PM2_BIN=server\node_modules\.bin\pm2.cmd"

echo   Launching under PM2...
echo.
"%PM2_BIN%" startOrRestart ecosystem.config.cjs --update-env

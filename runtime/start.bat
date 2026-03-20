@echo off
cd /d "%~dp0"

rem Read the pack name
set "PACK_NAME=Skills Pack"
where node >nul 2>nul
if %errorlevel% equ 0 (
  if exist "skillpack.json" (
    for /f "delims=" %%i in ('node -e "console.log(JSON.parse(require('fs').readFileSync('skillpack.json','utf-8')).name)" 2^>nul') do set "PACK_NAME=%%i"
  )
)

echo.
echo   Starting %PACK_NAME%...
echo.

rem Install dependencies
if not exist "server\node_modules" (
  echo   Installing dependencies...
  cd server && npm install --omit=dev && cd ..
  echo.
)

rem First-run flag
set "FIRST_RUN=1"

:loop
set "SKILLPACK_FIRST_RUN=%FIRST_RUN%"
set "PACK_ROOT=%~dp0"
set "NODE_ENV=production"
node server\dist\index.js
set "EXIT_CODE=%errorlevel%"

set "FIRST_RUN=0"

rem Only restart on exit code 75 (/restart command)
if %EXIT_CODE% equ 75 (
  echo.
  echo   Restarting...
  timeout /t 1 /nobreak >nul
  goto loop
)

rem All other exit codes → stop
if %EXIT_CODE% equ 64 (
  echo.
  echo   Shutdown complete.
) else if %EXIT_CODE% neq 0 (
  echo.
  echo   Process exited with code %EXIT_CODE%.
)

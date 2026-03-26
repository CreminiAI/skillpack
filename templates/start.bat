@echo off
cd /d "%~dp0"

rem First-run flag
set "FIRST_RUN=1"

:loop
set "SKILLPACK_FIRST_RUN=%FIRST_RUN%"
set "PACK_ROOT=%~dp0"
npx -y @cremini/skillpack run .
set "EXIT_CODE=%errorlevel%"

set "FIRST_RUN=0"

rem Only restart on exit code 75 (/restart command)
if %EXIT_CODE% equ 75 (
  echo.
  echo   Restarting...
  timeout /t 1 /nobreak >nul
  goto loop
)

rem All other exit codes (0, 64, crash, Ctrl+C, kill, etc.) → stop
if %EXIT_CODE% equ 64 (
  echo.
  echo   Shutdown complete.
) else if %EXIT_CODE% neq 0 (
  echo.
  echo   Process exited with code %EXIT_CODE%.
)

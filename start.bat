@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed or not on PATH.
  echo Install it from https://nodejs.org/ and try again.
  pause
  exit /b 1
)

where pnpm >nul 2>&1
if errorlevel 1 (
  echo Enabling pnpm via corepack...
  call corepack enable >nul 2>&1
  call corepack prepare pnpm@11.17.0 --activate >nul 2>&1
)

where pnpm >nul 2>&1
if errorlevel 1 (
  echo Installing pnpm...
  call npm install -g pnpm
  if errorlevel 1 (
    echo Failed to install pnpm.
    pause
    exit /b 1
  )
)

if not exist "node_modules\" (
  echo Installing dependencies...
  call pnpm install
  if errorlevel 1 (
    echo pnpm install failed.
    pause
    exit /b 1
  )
)

echo Starting Campaigner ^(browser opens automatically^)...
call pnpm exec vite --open
set EXITCODE=%ERRORLEVEL%
if not %EXITCODE%==0 (
  echo Dev server exited with code %EXITCODE%.
  pause
)
exit /b %EXITCODE%

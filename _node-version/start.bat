@echo off
title Pulse Messenger
cd /d "%~dp0"

echo ============================================
echo    Pulse Messenger - starting up...
echo ============================================
echo.

if not exist "node_modules" (
  echo Installing dependencies for the first time...
  call npm install
  echo.
)

echo Server starting. Open this in your browser:
echo    http://localhost:3000
echo.
echo (Close this window to stop the server.)
echo.

node server.js
pause

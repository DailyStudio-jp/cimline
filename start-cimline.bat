@echo off
setlocal
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js and npm are required to start CimLine.
  pause
  exit /b 1
)

if not exist "node_modules\.bin\vite.cmd" (
  echo Installing CimLine dependencies for the first run...
  call npm install
  if errorlevel 1 goto :failed
)

call npm run dev
if errorlevel 1 goto :failed
exit /b 0

:failed
echo CimLine could not be started. Check the messages above.
pause
exit /b 1

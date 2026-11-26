@echo off
setlocal
cd /d "%~dp0"

if /i "%~1"=="--background" goto :background

call :ensure_node
if errorlevel 1 exit /b 1

if not exist "node_modules\.bin\vite.cmd" (
  echo Installing CimLine dependencies for the first run...
  call npm install
  if errorlevel 1 goto :failed
)

set "CIMLINE_STARTUP_OUT=%TEMP%\CimLine-startup.out.log"
set "CIMLINE_STARTUP_ERR=%TEMP%\CimLine-startup.err.log"
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0start-cimline-hidden.ps1" "%~f0" "%CD%" "%CIMLINE_STARTUP_OUT%" "%CIMLINE_STARTUP_ERR%"
if errorlevel 1 goto :failed
exit /b 0

:background
call npm run dev
if errorlevel 1 exit /b 1
exit /b 0

:failed
echo CimLine could not be started. Check the messages above.
if exist "%CIMLINE_STARTUP_OUT%" type "%CIMLINE_STARTUP_OUT%"
if exist "%CIMLINE_STARTUP_ERR%" type "%CIMLINE_STARTUP_ERR%"
pause
exit /b 1

:ensure_node
set "NODE_MAJOR="
where node >nul 2>nul
if errorlevel 1 goto :install_node
for /f "tokens=1 delims=v." %%v in ('node --version 2^>nul') do set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR goto :install_node
if %NODE_MAJOR% LSS 24 goto :install_node
where npm >nul 2>nul
if errorlevel 1 goto :install_node
exit /b 0

:install_node
where winget >nul 2>nul
if errorlevel 1 goto :node_manual
echo Node.js 24 or later was not found. Installing the current Node.js LTS with WinGet...
winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-source-agreements
if errorlevel 1 goto :node_manual
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
set "NODE_MAJOR="
where node >nul 2>nul
if errorlevel 1 goto :node_manual
for /f "tokens=1 delims=v." %%v in ('node --version 2^>nul') do set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR goto :node_manual
if %NODE_MAJOR% LSS 24 goto :node_manual
where npm >nul 2>nul
if errorlevel 1 goto :node_manual
exit /b 0

:node_manual
echo.
echo CimLine needs Node.js 24 or later with npm.
echo Install it from https://nodejs.org/en/download/ and then run this file again.
start "" "https://nodejs.org/en/download/"
pause
exit /b 1

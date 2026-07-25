@echo off
setlocal

set "PORT=7777"

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required to run LocalForge.
  echo Install Node.js 20 or newer from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]"') do set "NODE_MAJOR=%%v"
for /f "delims=" %%v in ('node --version') do set "NODE_VERSION=%%v"
if "%NODE_MAJOR%"=="" (
  echo Could not determine the installed Node.js version.
  pause
  exit /b 1
)

if %NODE_MAJOR% LSS 20 (
  echo LocalForge requires Node.js 20 or newer. Found %NODE_VERSION%.
  echo Install Node.js 20 or newer from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Install Node.js 20 or newer from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing dependencies...
  if exist "package-lock.json" (
    call npm ci
  ) else (
    call npm install
  )
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

rem The SQLite driver is a native module, so its binary is tied to the Node.js
rem version it was installed for. better-sqlite3 loads that binary lazily on the
rem first connection, so probe it here and repair it now rather than failing at
rem page load with "Could not locate the bindings file".
node -e "new (require('better-sqlite3'))(':memory:').close()" >nul 2>nul
if errorlevel 1 (
  echo Native SQLite module is missing or built for a different Node.js version.
  echo Rebuilding for %NODE_VERSION%...
  call npm rebuild better-sqlite3
  node -e "new (require('better-sqlite3'))(':memory:').close()" >nul 2>nul
  if errorlevel 1 (
    call npm install
    node -e "new (require('better-sqlite3'))(':memory:').close()" >nul 2>nul
    if errorlevel 1 (
      echo Could not build the native SQLite module for %NODE_VERSION%.
      echo better-sqlite3 may not ship a prebuilt binary for this Node.js release yet.
      echo Switch to the current Node.js LTS and run this file again.
      pause
      exit /b 1
    )
  )
)

echo Applying database migrations...
call npm run db:migrate
if errorlevel 1 (
  echo Database migration failed.
  pause
  exit /b 1
)

echo Checking port %PORT%...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$port = %PORT%; $pids = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique); foreach ($processId in $pids) { if ($processId -ne $PID) { Write-Host \"Stopping process $processId on port $port...\"; Stop-Process -Id $processId -Force -ErrorAction Stop } }"
if errorlevel 1 (
  echo Failed to free port %PORT%.
  pause
  exit /b 1
)

echo Starting LocalForge at http://localhost:%PORT%
call npm run dev

@echo off
rem Baton recording kit launcher for Windows (PowerShell or cmd):  .\kit <command> [options]
rem Runs src\cli.ts through the local tsx, so it works from any directory and avoids the
rem PowerShell "npm run x -- --flag" argument-stripping problem.
if not exist "%~dp0node_modules\tsx\dist\cli.mjs" (
  echo Dependencies missing. Run:  cd "%~dp0" ^&^& npm install
  exit /b 1
)
node "%~dp0node_modules\tsx\dist\cli.mjs" "%~dp0src\cli.ts" %*

@echo off
cd /d "%~dp0"
if not exist "runtime\python.exe" (
  echo [ERROR] runtime\python.exe not found. Please keep the runtime folder.
  pause
  exit /b 1
)
"runtime\python.exe" server.py
if errorlevel 1 pause

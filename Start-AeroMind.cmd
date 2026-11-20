@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Install the Python environment as described in README.md.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" -m aeromind.app --open
if errorlevel 1 pause

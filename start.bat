@echo off
start "Local HTML test server" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
exit /b 0

@echo off
setlocal
set "MODE=%~1"
if "%MODE%"=="" set "MODE=normal"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0LoopilotLauncher.ps1" -Mode "%MODE%"
endlocal

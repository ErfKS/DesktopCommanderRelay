@echo off
setlocal EnableExtensions
title Desktop Commander - Home PC Sandbox Agent

set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%start-home-pc-sandbox-agent.ps1"

if not exist "%PS_SCRIPT%" (
    echo [ERROR] PowerShell launcher not found:
    echo         %PS_SCRIPT%
    echo.
    pause
    exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo Sandbox agent stopped with exit code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%

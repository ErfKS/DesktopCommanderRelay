@echo off
setlocal

set "CONFIG=%~dp0sandbox-mounts.txt"
set "EXAMPLE=%~dp0sandbox-mounts.example.txt"

if not exist "%CONFIG%" (
    if not exist "%EXAMPLE%" (
        echo [ERROR] Neither sandbox-mounts.txt nor sandbox-mounts.example.txt exists.
        pause
        exit /b 1
    )

    copy /Y "%EXAMPLE%" "%CONFIG%" >nul

    if errorlevel 1 (
        echo [ERROR] Could not create sandbox-mounts.txt.
        pause
        exit /b 1
    )
)

start "" notepad.exe "%CONFIG%"

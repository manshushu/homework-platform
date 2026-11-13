@echo off
cd /d "%~dp0"
title Homework Platform Server Launcher
cls
echo ========================================================
echo   Starting Homework Platform Server...
echo ========================================================
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launcher.ps1"
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Server stopped with error code %ERRORLEVEL%.
    pause
)

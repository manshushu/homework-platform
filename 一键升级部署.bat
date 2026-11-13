@echo off
cd /d "%~dp0"
title Homework Platform - One-Click Upgrade
cls
echo ========================================================
echo   Homework Platform - One-Click Upgrade and Deploy
echo ========================================================
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\upgrade_deploy.ps1"
set EXIT_CODE=%ERRORLEVEL%
echo.
if %EXIT_CODE% NEQ 0 (
    echo Upgrade finished with error code %EXIT_CODE%.
)
pause
exit /b %EXIT_CODE%

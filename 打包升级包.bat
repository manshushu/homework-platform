@echo off
cd /d "%~dp0"
title Homework Platform - Build Update Package
cls
echo ========================================================
echo   Homework Platform - Build Update Package
echo ========================================================
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build_update_pack.ps1"
set EXIT_CODE=%ERRORLEVEL%
echo.
if %EXIT_CODE% NEQ 0 (
    echo Build finished with error code %EXIT_CODE%.
)
pause
exit /b %EXIT_CODE%

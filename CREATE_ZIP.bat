@echo off
title Create Portable ZIP
color 0E
echo ============================================
echo   Creating Portable ZIP Package
echo ============================================
echo.

set ZIPNAME=maintenance-management.zip

:: Remove old zip if exists
if exist "%ZIPNAME%" del /f "%ZIPNAME%"

:: Create zip excluding node_modules, database, logs
echo Packaging files (excluding node_modules, database, logs)...
echo.

powershell -ExecutionPolicy Bypass -File create_zip.ps1

if exist "%ZIPNAME%" (
    echo.
    echo [OK] Created: %ZIPNAME%
    echo.
    echo Transfer this ZIP to the other PC, extract it, and:
    echo   1. Double-click install.bat  (one-time setup)
    echo   2. Double-click START.bat    (run the server)
    echo.
    echo NOTE: The other PC must have Node.js installed.
    echo       Download from: https://nodejs.org
) else (
    echo [ERROR] Failed to create ZIP file.
)

echo.
pause

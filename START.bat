@echo off
title Maintenance Management System
color 0B

:: Check if node_modules exists, if not run install first
if not exist node_modules (
    echo Dependencies not installed. Running setup first...
    echo.
    call install.bat
    if %errorlevel% neq 0 exit /b 1
)

:: Check if Node.js is available
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed. Please run install.bat first.
    pause
    exit /b 1
)

:: Kill any existing node processes on port 3000
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING 2^>nul') do (
    taskkill /F /PID %%a >nul 2>nul
)

:: Get LAN IP address
set LANIP=localhost
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /C:"IPv4"') do (
    for /f "tokens=1" %%b in ("%%a") do (
        set LANIP=%%b
    )
)

echo ============================================
echo   Maintenance Management System
echo ============================================
echo.
echo   Local:    http://localhost:3000
echo   Network:  http://%LANIP%:3000
echo.
echo   Admin Login:  admin / admin123
echo   Engineers:    Scan QR code with phone camera
echo.
echo   Use the Network URL on mobile devices
echo   (phone must be on the same WiFi)
echo.
echo   Press Ctrl+C to stop the server.
echo ============================================
echo.

node server.js

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Server crashed. Check the error above.
    pause
)
stop 
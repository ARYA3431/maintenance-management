@echo off
title Maintenance Management - Public (ngrok)
color 0A

:: Check if ngrok exists
if not exist ngrok.exe (
    echo [ERROR] ngrok.exe not found in this folder.
    echo Download it from: https://ngrok.com/download
    pause
    exit /b 1
)

:: Check if node_modules exists
if not exist node_modules (
    echo Dependencies not installed. Running setup first...
    call install.bat
    if %errorlevel% neq 0 exit /b 1
)

:: Kill existing processes
echo Stopping any existing server...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING 2^>nul') do (
    taskkill /F /PID %%a >nul 2>nul
)
taskkill /F /IM ngrok.exe >nul 2>nul
timeout /t 2 /nobreak >nul

:: Start Node.js server in background
echo Starting server on port 3000...
start /B "NodeServer" cmd /c "node server.js > server.log 2>&1"
timeout /t 3 /nobreak >nul

:: Verify server is running
curl -s -o nul -w "%%{http_code}" http://localhost:3000 >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Server failed to start. Check server.log
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Maintenance Management System - PUBLIC
echo ============================================
echo.
echo   Local:  http://localhost:3000
echo   Admin:  admin / admin123
echo.
echo   Starting ngrok tunnel...
echo   The public URL will appear below.
echo   Share that URL with anyone to access the app.
echo.
echo   Press Ctrl+C to stop everything.
echo ============================================
echo.

:: Start ngrok (this blocks and shows the UI)
ngrok.exe http 3000

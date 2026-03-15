@echo off
title Maintenance Management System - Setup
color 0A
echo ============================================
echo   Maintenance Management System - Setup
echo ============================================
echo.

:: Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is NOT installed on this PC.
    echo.
    echo Please install Node.js first:
    echo   1. Go to https://nodejs.org
    echo   2. Download the LTS version
    echo   3. Install it (check "Add to PATH" during install)
    echo   4. Restart this script after installation
    echo.
    pause
    exit /b 1
)

echo [OK] Node.js found: 
node --version
echo.

:: Install dependencies
echo [STEP 1] Installing dependencies...
echo.
call npm install
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Failed to install dependencies.
    pause
    exit /b 1
)
echo.
echo [OK] Dependencies installed successfully.
echo.

:: Delete old database so it starts fresh
if exist maintenance.db (
    del /f maintenance.db
    echo [OK] Old database removed. A fresh one will be created on startup.
) else (
    echo [OK] Fresh database will be created on startup.
)
echo.

echo ============================================
echo   Setup Complete!
echo ============================================
echo.
echo To start the server, double-click: START.bat
echo.
pause

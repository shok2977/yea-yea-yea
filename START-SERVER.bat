@echo off
title TubeStream Server
REM UPDATED 2026-11-06: on-demand build. No prefetch/warm queue/pool engine —
REM every feed, search and video stream is resolved live from xhamster's own
REM server payload when the user asks for it (same model as the real site).
cd /d "%~dp0"

echo ============================================
echo   TubeStream Server - http://localhost:3080
echo ============================================
echo   Band karne ke liye ye window close kar dena
echo   (ya Ctrl+C dabana)
echo.

REM Purana server band karo agar chal raha ho (dono ports check)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3080 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3001 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1

set PORT=3080
node server.js

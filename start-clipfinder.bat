@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ClipFinder
where node >nul 2>&1 || (echo Node.js introuvable : installez-le sur https://nodejs.org & pause & exit /b 1)
if not exist node_modules (echo Installation des dependances... & call npm install || (pause & exit /b 1))
where ffmpeg >nul 2>&1 || echo [!] ffmpeg absent : winget install Gyan.FFmpeg  (puis rouvrez ce lanceur)
if not exist .env if exist .env.example copy .env.example .env >nul
start "" cmd /c "timeout /t 3 >nul & start http://localhost:3000"
call npm start
pause

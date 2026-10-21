@echo off
chcp 65001 > nul
cd /d "%~dp0"
title J.A.R.V.I.S.

rem 作業させたいフォルダ（変更したいときはこの行を書き換える）
if "%JARVIS_WORKDIR%"=="" set "JARVIS_WORKDIR=%USERPROFILE%\Documents"

where node > nul 2>&1
if errorlevel 1 (
  echo [エラー] Node.js が見つかりません。https://nodejs.org からインストールしてください。
  pause
  exit /b 1
)
where claude > nul 2>&1
if errorlevel 1 (
  echo [エラー] Claude Code が見つかりません。次のコマンドでインストールしてください:
  echo   npm install -g @anthropic-ai/claude-code
  pause
  exit /b 1
)

start "" cmd /c "timeout /t 2 > nul & start http://localhost:7777"
node server.js
pause

@echo off
chcp 65001 > nul
cd /d "%~dp0"

where node > nul 2> nul
if %errorlevel% == 0 (
  node server.js
) else (
  "C:\Users\hakke\AppData\Local\OpenAI\Codex\bin\node.exe" server.js
)

pause

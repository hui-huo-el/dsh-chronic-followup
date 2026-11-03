@echo off
chcp 65001 >nul
cd /d "%~dp0"
if "%~1"=="" (
  node run.js --disease hp --status 快到期 --count 5
) else (
  node run.js %*
)
pause

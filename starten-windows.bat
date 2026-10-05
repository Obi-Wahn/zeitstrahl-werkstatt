@echo off
rem Zeitstrahl-Werkstatt: Klassenserver starten (Windows)
rem Der Port steht in einstellungen.txt
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js ist nicht installiert. Bitte einmalig von https://nodejs.org die LTS-Version installieren.
  echo.
  pause
  exit /b 1
)
node server.js %*
pause

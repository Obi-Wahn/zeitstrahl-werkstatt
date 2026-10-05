@echo off
rem Zeitstrahl-Werkstatt: Klassenserver starten (Windows)
rem Der Port steht in einstellungen.txt
cd /d "%~dp0"

rem Node.js suchen: zuerst im Pfad, sonst am ueblichen Installationsort.
rem Ein Konsolenfenster, das schon vor der Installation offen war, kennt den Pfad noch nicht.
set "NODE=node"
where node >nul 2>nul
if not errorlevel 1 goto start
set "NODE=%ProgramFiles%\nodejs\node.exe"
if exist "%NODE%" goto start
set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if exist "%NODE%" goto start

echo.
echo Node.js wurde nicht gefunden. Bitte einmalig von https://nodejs.org die LTS-Version installieren.
echo Falls Node.js gerade erst installiert wurde: dieses Fenster schliessen und eine neue Konsole oeffnen.
echo.
pause
exit /b 1

:start
"%NODE%" server.js %*
pause

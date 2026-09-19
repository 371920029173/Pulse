@echo off
REM SHE launcher for Windows.
REM
REM ASCII only, on purpose: a .bat is read in the console's OEM codepage, so any
REM non-ASCII byte here can break parsing. All logic and all localized text live
REM in scripts\she.mjs, which handles encoding properly.
REM
REM   SHE.bat              start (desktop window if Electron is installed)
REM   SHE.bat --browser    start, but open a browser instead
REM   SHE.bat stop         stop the backend and close the window
REM   SHE.bat restart      stop, then start
REM   SHE.bat status       report what is running

setlocal
set "HERE=%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node 20+: https://nodejs.org
  echo.
  pause
  exit /b 1
)

node "%HERE%scripts\she.mjs" %*
set "CODE=%ERRORLEVEL%"

REM Keep the window open when the launcher failed, so a double-click shows why.
if not "%CODE%"=="0" (
  echo.
  pause
)
exit /b %CODE%

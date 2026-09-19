@echo off
REM Stop SHE on Windows. ASCII only - see SHE.bat for why.
setlocal
set "HERE=%~dp0"
node "%HERE%scripts\she.mjs" stop
pause
exit /b 0

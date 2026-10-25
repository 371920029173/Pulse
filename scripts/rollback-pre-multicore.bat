@echo off
rem ===========================================================================
rem  One-click rollback for D:\AGI\she-agent-cloud
rem  Target: git tag pre-multicore  (the state before the multi-core work)
rem
rem  Written as ASCII on purpose: a .bat with UTF-8 Chinese text is decoded with
rem  the OEM code page and can corrupt the commands themselves.
rem ===========================================================================
setlocal
set REPO=D:\AGI\she-agent-cloud
set ANCHOR=pre-multicore

echo.
echo === Pulse / SHE : one-click rollback ===
echo.

if not exist "%REPO%\.git" (
  echo [FAIL] not a git repo: %REPO%
  goto :end
)

cd /d "%REPO%" || (
  echo [FAIL] cannot enter %REPO%
  goto :end
)

echo Current HEAD:
git log --oneline -1
echo.

git rev-parse --verify --quiet %ANCHOR% >nul
if errorlevel 1 (
  echo [FAIL] rollback anchor "%ANCHOR%" not found.
  echo        Available tags:
  git tag
  goto :end
)

echo Rollback anchor %ANCHOR% =
git rev-parse --short %ANCHOR%
echo.

echo This will run:  git reset --hard %ANCHOR%
echo Uncommitted work (if any) is stashed first, not lost.
echo.
choice /c YN /m "Continue"
if errorlevel 2 goto :cancel

rem --- keep uncommitted work, do not destroy it ---
for /f "usebackq delims=" %%L in (`git status --porcelain`) do (
  echo Stashing uncommitted work...
  git stash push -u -m "auto-stash before rollback"
  goto :stashed
)
:stashed

echo.
echo [1/3] git reset --hard %ANCHOR%
git reset --hard %ANCHOR% || goto :fail

echo.
echo [2/3] pnpm -r build
call pnpm -r build || goto :fail

echo.
echo [3/3] stage desktop runtime
node scripts\stage-desktop-runtime.mjs || goto :fail

echo.
echo === DONE ===
echo Rolled back to %ANCHOR%. Now RESTART the desktop app (not Ctrl+R):
echo   SHE-stop.bat  then  SHE.bat
goto :end

:cancel
echo Cancelled. Nothing changed.
goto :end

:fail
echo.
echo [FAIL] a step failed. Your work is safe:
echo   - stashed changes:  git stash list
echo   - current state:    git log --oneline -1
goto :end

:end
echo.
pause
endlocal

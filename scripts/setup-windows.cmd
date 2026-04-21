@echo off
setlocal EnableExtensions

rem ============================================================
rem  Photo Importer - Windows setup script
rem  Usage:  double-click, or from a cmd prompt:
rem    scripts\setup-windows.cmd          (interactive menu)
rem    scripts\setup-windows.cmd dev      (install + npm start)
rem    scripts\setup-windows.cmd build    (install + npm run make)
rem    scripts\setup-windows.cmd install  (install only)
rem ============================================================

pushd "%~dp0.."

echo.
echo ============================================================
echo   Photo Importer - Windows setup
echo ============================================================
echo.

rem ---------- 1. Node check ----------
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js was not found on your PATH.
  echo         Install Node 20+ from https://nodejs.org/ and re-run this script.
  goto :fail
)

node -e "process.exit(parseInt(process.versions.node)<20?1:0)"
if errorlevel 1 (
  echo [ERROR] Node 20 or newer is required. Detected:
  node -v
  goto :fail
)
echo [ok] Node
node -v

rem ---------- 2. npm check ----------
where npm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm was not found. Reinstall Node.js with npm enabled.
  goto :fail
)
echo [ok] npm
call npm -v

rem ---------- 3. git check (optional, only warn) ----------
where git >nul 2>&1
if errorlevel 1 (
  echo [warn] git not found on PATH. Fine if you already have the source;
  echo        install from https://git-scm.com/ if you want to pull updates.
) else (
  echo [ok] git
)

echo.

rem ---------- 4. pick action ----------
set "ACTION=%~1"
if not "%ACTION%"=="" goto :run

:menu
echo What would you like to do?
echo   [1] Install dependencies only
echo   [2] Install + run in dev mode
echo   [3] Install + build installer
echo   [q] Quit
echo.
set "CHOICE="
set /p CHOICE="Choice: "
if /i "%CHOICE%"=="1" set "ACTION=install"
if /i "%CHOICE%"=="2" set "ACTION=dev"
if /i "%CHOICE%"=="3" set "ACTION=build"
if /i "%CHOICE%"=="q" goto :done
if "%ACTION%"=="" (
  echo Invalid choice.
  echo.
  goto :menu
)

:run
echo.
echo --- Installing dependencies ---
if not exist package-lock.json goto :do_install_no_lock
call npm ci
if not errorlevel 1 goto :install_ok
echo.
echo [warn] "npm ci" failed - lock file may be out of sync.
echo        Retrying with "npm install" to reconcile...
echo.
call npm install
if errorlevel 1 goto :install_failed
goto :install_ok

:do_install_no_lock
echo   package-lock.json missing, using "npm install"
call npm install
if errorlevel 1 goto :install_failed

:install_ok
if /i "%ACTION%"=="install" goto :done
if /i "%ACTION%"=="dev"     goto :do_dev
if /i "%ACTION%"=="build"   goto :do_build

echo Unknown action: %ACTION%
goto :fail

:do_dev
echo.
echo --- Starting in dev mode. Press Ctrl+C to stop. ---
call npm start
goto :done

:do_build
echo.
echo --- Building Windows installer ---
call npm run make
if errorlevel 1 goto :build_failed
echo.
echo Build artifacts:
if exist out\make dir /s /b out\make\*.exe out\make\*.zip 2>nul
goto :done

:install_failed
echo [ERROR] npm install failed.
goto :fail

:build_failed
echo [ERROR] Build failed. Check the output above.
goto :fail

:done
echo.
echo Done.
popd
endlocal
pause
exit /b 0

:fail
echo.
echo Setup did not complete. See messages above.
popd
endlocal
pause
exit /b 1

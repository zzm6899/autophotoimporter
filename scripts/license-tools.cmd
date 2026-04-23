@echo off
setlocal EnableExtensions
pushd "%~dp0.."

if not "%~1"=="" (
  node scripts\license-console.mjs %*
  set "ERR=%ERRORLEVEL%"
  popd
  endlocal
  exit /b %ERR%
)

:menu
cls
echo.
echo ============================================================
echo   Photo Importer - License and Build Tools
echo ============================================================
echo.
echo   [1] Show keypair/build status
echo   [2] Create signing keypair
echo   [3] Generate customer license key
echo   [4] Build Windows app
echo   [q] Quit
echo.
set "CHOICE="
set /p CHOICE="Choice: "

if /i "%CHOICE%"=="1" goto :status
if /i "%CHOICE%"=="2" goto :keypair
if /i "%CHOICE%"=="3" goto :create
if /i "%CHOICE%"=="4" goto :build
if /i "%CHOICE%"=="q" goto :done
goto :menu

:status
echo.
node scripts\license-console.mjs status
goto :pause

:keypair
echo.
echo Creating signing keypair...
node scripts\license-console.mjs keypair
goto :pause

:create
echo.
set "NAME="
set "EMAIL="
set "EXPIRY="
set "TIER="
set "NOTES="
set /p NAME="Customer name: "
if "%NAME%"=="" (
  echo Name is required.
  goto :pause
)
set /p EMAIL="Email (optional): "
set /p EXPIRY="Expiry DD-MM-YYYY (optional): "
set /p TIER="Tier (optional): "
set /p NOTES="Notes (optional): "
set "ARGS=create --name ""%NAME%"""
if not "%EMAIL%"=="" set "ARGS=%ARGS% --email ""%EMAIL%"""
if not "%EXPIRY%"=="" set "ARGS=%ARGS% --expiry ""%EXPIRY%"""
if not "%TIER%"=="" set "ARGS=%ARGS% --tier ""%TIER%"""
if not "%NOTES%"=="" set "ARGS=%ARGS% --notes ""%NOTES%"""
echo.
call node scripts\license-console.mjs %ARGS%
goto :pause

:build
echo.
node scripts\license-console.mjs status
echo.
echo Building app with the current embedded public key...
node scripts\license-console.mjs build
goto :pause

:pause
echo.
pause
goto :menu

:done
popd
endlocal
exit /b 0

@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0release-windows.ps1" %*
exit /b %errorlevel%

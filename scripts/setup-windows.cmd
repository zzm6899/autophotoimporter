@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem ============================================================
rem  Photo Importer - Windows setup script
rem  Usage:  double-click, or from a cmd prompt:
rem    scripts\setup-windows.cmd                (interactive menu)
rem    scripts\setup-windows.cmd dev            (install + npm start)
rem    scripts\setup-windows.cmd build          (install + npm run make)
rem    scripts\setup-windows.cmd install        (install only)
rem    scripts\setup-windows.cmd release        (bump version, tag, push)
rem    scripts\setup-windows.cmd commit         (stage all, commit, push)
rem    scripts\setup-windows.cmd publish-models (upload ONNX models to GitHub)
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

rem ---------- 3. git check (required for release, optional otherwise) ----------
where git >nul 2>&1
if errorlevel 1 (
  echo [warn] git not found on PATH. Fine if you already have the source;
  echo        install from https://git-scm.com/ if you want to pull updates.
  set "GIT_AVAILABLE=0"
) else (
  echo [ok] git
  set "GIT_AVAILABLE=1"
)

echo.

rem ---------- 4. pick action ----------
set "ACTION=%~1"
if not "%ACTION%"=="" goto :dispatch

:menu
echo What would you like to do?
echo   [1] Install dependencies only
echo   [2] Install + run in dev mode
echo   [3] Install + build installer
echo   [4] Release        - bump version, tag, and push (triggers GitHub build)
echo   [5] Commit         - stage all changes and push to current branch
echo   [6] Publish models - upload ONNX culling models to GitHub release
echo   [q] Quit
echo.
set "CHOICE="
set /p CHOICE="Choice: "
if /i "%CHOICE%"=="1" set "ACTION=install"
if /i "%CHOICE%"=="2" set "ACTION=dev"
if /i "%CHOICE%"=="3" set "ACTION=build"
if /i "%CHOICE%"=="4" set "ACTION=release"
if /i "%CHOICE%"=="5" set "ACTION=commit"
if /i "%CHOICE%"=="6" set "ACTION=publish-models"
if /i "%CHOICE%"=="q" goto :done
if "%ACTION%"=="" (
  echo Invalid choice.
  echo.
  goto :menu
)

:dispatch
rem These actions skip npm install.
if /i "%ACTION%"=="release"        goto :do_release
if /i "%ACTION%"=="commit"         goto :do_commit
if /i "%ACTION%"=="publish-models" goto :do_publish_models

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
echo.
echo --- Downloading ONNX culling models (skipped if already present) ---
call npm run models
if errorlevel 1 (
  echo [warn] Model download failed. Face recognition will be unavailable.
  echo        Re-run "npm run models" once internet is available.
)

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

rem ============================================================
rem  Commit flow
rem  - Stages all tracked + untracked changes (git add -A)
rem  - Prompts for a commit message (required)
rem  - Commits and pushes to the current branch
rem ============================================================
:do_commit
echo.
echo --- Commit and push ---
echo.

if "%GIT_AVAILABLE%"=="0" (
  echo [ERROR] git is required for the commit action.
  goto :fail
)

rem Check there is actually something to commit
git status --porcelain 2>nul | findstr /r "." >nul
if errorlevel 1 (
  echo [warn] Nothing to commit -- working tree is clean.
  goto :done
)

rem Show a short status so the user knows what will be staged
echo Changed files:
git status --short
echo.

set "COMMIT_MSG="
set /p COMMIT_MSG="Commit message: "
if "!COMMIT_MSG!"=="" (
  echo [ERROR] Commit message cannot be empty.
  goto :fail
)

git add -A
if errorlevel 1 goto :commit_failed

git commit -m "!COMMIT_MSG!"
if errorlevel 1 goto :commit_failed

echo.
echo Pushing to remote...
git push
if errorlevel 1 (
  echo.
  echo [ERROR] Push failed. Your local commit is intact.
  echo         Fix the remote issue (e.g. pull first) and run:  git push
  goto :fail
)

echo.
echo [ok] Changes committed and pushed.
goto :done

:commit_failed
echo [ERROR] git commit failed. Check the output above.
goto :fail

rem ============================================================
rem  Release flow
rem  - Reads current version from package.json
rem  - Prompts for new version (default: patch bump)
rem  - Updates package.json
rem  - git commit + tag vX.Y.Z
rem  - git push --follow-tags  (triggers GitHub Actions build.yml)
rem ============================================================
:do_release
echo.
echo --- Release ---
echo.

if "%GIT_AVAILABLE%"=="0" (
  echo [ERROR] git is required for the release action.
  goto :fail
)

rem Read current version from package.json via Node
for /f "delims=" %%V in ('node -e "process.stdout.write(require('./package.json').version)"') do set "CURRENT_VER=%%V"
echo Current version: %CURRENT_VER%

rem Auto-compute a patch bump (1.2.3 -> 1.2.4)
for /f "delims=" %%B in ('node -e "const v=require('./package.json').version.split('.').map(Number);v[2]++;process.stdout.write(v.join('.'))"') do set "BUMPED_VER=%%B"

echo.
set "NEW_VER="
set /p NEW_VER="New version [%BUMPED_VER%]: "
if "!NEW_VER!"=="" set "NEW_VER=%BUMPED_VER%"

rem Basic format check: must match digits.digits.digits (optional pre-release ok)
echo !NEW_VER! | findstr /r "^[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*" >nul
if errorlevel 1 (
  echo [ERROR] Version must start with MAJOR.MINOR.PATCH, e.g. 1.2.3
  goto :fail
)

echo.
echo Releasing v!NEW_VER! ...

rem Check for uncommitted changes
git diff --quiet --exit-code 2>nul
if errorlevel 1 (
  echo [warn] You have unstaged changes. They will NOT be included in this commit.
  echo        Commit or stash them first if you want them in the release.
  echo.
  set "CONT="
  set /p CONT="Continue anyway? [y/N]: "
  if /i not "!CONT!"=="y" goto :fail
)

rem Update package.json + package-lock.json using npm so both stay in sync
call npm version !NEW_VER! --no-git-tag-version
if errorlevel 1 (
  echo [ERROR] Failed to update package version metadata
  goto :fail
)
echo [ok] package.json and package-lock.json updated to !NEW_VER!

rem Stage and commit
git add package.json package-lock.json
if errorlevel 1 goto :release_failed

git commit -m "chore: release v!NEW_VER!"
if errorlevel 1 goto :release_failed

rem Create annotated tag
git tag -a "v!NEW_VER!" -m "Release v!NEW_VER!"
if errorlevel 1 goto :release_failed

echo.
echo [ok] Committed and tagged v!NEW_VER!
echo.
echo Pushing to remote (this triggers the GitHub Actions build)...
git push --follow-tags
if errorlevel 1 (
  echo.
  echo [ERROR] Push failed. Your local commit and tag are intact.
  echo         Fix the remote issue and run:  git push --follow-tags
  goto :fail
)

echo.
echo [ok] Released v!NEW_VER! -- GitHub Actions will now build the installers.
echo      Watch progress at: https://github.com/zzm6899/autophotoimporter/actions
goto :done

rem ============================================================
rem  Publish models flow
rem  - Prompts for a GitHub token (or reads GH_TOKEN env var)
rem  - Creates the models-v1 release if it doesn't exist
rem  - Downloads model files and uploads them as release assets
rem ============================================================
:do_publish_models
echo.
echo --- Publish ONNX models to GitHub ---
echo.
echo This uploads the ONNX culling models to your GitHub release so
echo end-users can download them automatically on first launch.
echo.
echo You need a GitHub token with Contents: write access to the target repo.
echo Get one at: https://github.com/settings/personal-access-tokens/new
echo.

set "GH_TOKEN_INPUT=%GH_TOKEN%"
if "!GH_TOKEN_INPUT!"=="" (
  set /p GH_TOKEN_INPUT="GitHub token (ghp_...): "
)
if "!GH_TOKEN_INPUT!"=="" (
  echo [ERROR] GitHub token is required.
  goto :fail
)

set "GH_TOKEN=!GH_TOKEN_INPUT!"
call npm run models:publish
if errorlevel 1 (
  echo [ERROR] Model publish failed. See output above.
  goto :fail
)
goto :done

:install_failed
echo [ERROR] npm install failed.
goto :fail

:build_failed
echo [ERROR] Build failed. Check the output above.
goto :fail

:release_failed
echo [ERROR] Release step failed. Check git output above.
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

@echo off
cd /d "%~dp0"
echo Removing stale git lock...
del /f .git\index.lock 2>nul
echo.
echo Staging changed files...
git add src/main/ipc-handlers.ts src/main/services/face-engine.ts src/renderer/components/SettingsPage.tsx src/renderer/components/ThumbnailGrid.tsx src/renderer/utils/previewCache.ts
echo.
echo Committing...
git commit -m "fix: face semaphore deadlock, catch dispatch, idle-cancel deadlock, clear-cache reset

- ipc-handlers: fix double-increment in acquireFaceSemaphore that caused
  faceActiveCount to leak above faceSemaphoreSlots after the first file,
  deadlocking the entire face queue (0/N forever). releaseFaceSemaphore
  pre-claims the slot before waking a waiter; acquire must not re-claim it.
  Stale-job path now correctly releases the pre-claimed slot.

- ThumbnailGrid: move sharpnessInFlightRef=true inside run() so if effect
  cleanup cancels the idle/timeout before it fires, the ref stays false and
  the loop is not permanently stuck.

- ThumbnailGrid: catch block now dispatches SET_REVIEW_SCORES so failed
  files exit the candidate pool (sharpnessScore becomes a number) instead
  of being retried forever with analyzed count stuck at 0.

- SettingsPage: Clear Face Cache now dispatches CLEAR_FACE_DATA and fires
  resume-ai so the renderer overlay is reset and files are actually
  re-analyzed instead of serving stale overlay results from memory.

- face-engine: detectFaces + detectPersons run in parallel (Promise.all);
  return all boxes not the sliced facesToEmbed.

- previewCache: raise MAX_PREVIEWS 24->500, MAX_ACTIVE_REQUESTS 2->6."
echo.
echo Pushing...
git push
echo.
echo Done! Press any key to close.
pause

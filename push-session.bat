@echo off
cd /d "%~dp0"
git add web/index.html services/update-admin/server.js
git commit -m "Dynamic pricing on website: monthly/yearly/lifetime toggle + live API endpoint"
git push
echo Done!
pause

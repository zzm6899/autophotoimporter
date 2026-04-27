@echo off
cd /d "%~dp0"
git add web/index.html services/update-admin/server.js
git commit -m "Fix server crashes, add dynamic pricing to website

- server.js: remove orphaned HTML fragment causing SyntaxError at line 2161
- server.js: fix ensurePricingSchema() race condition with pg_advisory_lock
- server.js: add GET /api/v1/pricing endpoint for frontend consumption
- web/index.html: dynamic pricing section with monthly/yearly/lifetime toggle
- web/index.html: improved workflow animations (AI review, auto-import demos)"
git push
echo Done!
pause

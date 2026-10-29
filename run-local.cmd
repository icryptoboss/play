@echo off
set PORT=8000
set PROXY_ALLOWED_HOSTS=*
set PROXY_ACCESS_KEY=mysecret
set STREAM_ALLOWED_HOSTS=*
set STREAM_SECRET=mysecretkey
REM Optional Cloudflare accelerator: set STREAM_ACCELERATOR_URL=https://your-worker.workers.dev
where node >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  node server\server.mjs
) else (
  "C:\Users\PATEL\AppData\Roaming\Antigravity\bin\agy-node.cmd" "%~dp0server\server.mjs"
)


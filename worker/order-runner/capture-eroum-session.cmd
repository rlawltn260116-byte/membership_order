@echo off
cd /d "%~dp0"
if not exist node_modules call npm install
echo.
echo A Chrome window will open. Log in to Eroum yourself.
node capture-eroum-session.mjs
echo.
echo If it says LOGIN_CAPTURED, the session is copied to the clipboard.
echo Paste it (Ctrl+V) into the GitHub secret EROUM_STORAGE_STATE_JSON.
pause

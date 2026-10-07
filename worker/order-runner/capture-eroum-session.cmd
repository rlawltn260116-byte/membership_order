@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo 필요한 패키지를 설치합니다...
  call npm install
)
echo.
echo 이로움 로그인 창이 열립니다. 아이디/비밀번호를 직접 입력해 로그인하세요.
node capture-eroum-session.mjs
echo.
echo 완료되면 https://github.com/rlawltn260116-byte/membership_order/settings/secrets/actions 에서
echo EROUM_STORAGE_STATE_JSON 의 연필(수정) 아이콘을 눌러 Ctrl+V 로 붙여넣고 저장하세요.
pause

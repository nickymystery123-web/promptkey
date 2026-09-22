@echo off
chcp 65001 >nul
title PromptKey 一键演示启动
echo ==============================================
echo    PromptKey 一键演示启动
echo ==============================================
echo.

set "ROOT=%~dp0.."
set "CLOUDFLARED=%~dp0cloudflared.exe"

if not exist "%CLOUDFLARED%" (
  echo [错误] 找不到 cloudflared.exe，请确认它在 deploy 目录下
  pause
  exit /b 1
)

echo [1/2] 启动本地服务 (127.0.0.1:8787) ...
start "PromptKey-Backend" cmd /k "cd /d ""%ROOT%"" && node server/server.js"
timeout /t 3 /nobreak >nul

echo [2/2] 启动公网隧道 ...
start "Cloudflare-Tunnel" cmd /k """%CLOUDFLARED%"" tunnel --url http://127.0.0.1:8787 --no-autoupdate"
timeout /t 10 /nobreak >nul

echo.
echo ==============================================
echo   完成！请在弹出的 "Cloudflare-Tunnel" 窗口里
echo   找到你的公网链接（形如）：
echo.
echo       https://xxxxx.trycloudflare.com
echo.
echo   把这个链接发给面试官即可。
echo ==============================================
echo.
echo 提示：
echo   - 两个黑色窗口都要保持打开，链接才有效
echo   - 面试完直接关掉这两个窗口即可
echo   - 下次要用，再双击本脚本，会生成新链接
echo.
pause

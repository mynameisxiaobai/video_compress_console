@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"

rem ---------------------------------------------------------------
rem  Video Compress Console 一键启动
rem  依次尝试：PATH 里的 node -> 本机常见安装位置
rem ---------------------------------------------------------------
set "NODE_EXE="
where node >nul 2>&1 && set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE_EXE (
  echo.
  echo   [错误] 没有找到 Node.js
  echo   请先安装 Node.js 18+ ： https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo.
echo   Video Compress Console
echo   ==========================================
echo   Node : %NODE_EXE%
echo   ffmpeg: 首次启动会在页面设置里指定，或放进 PATH
echo   ==========================================
echo   The browser will open automatically.
echo   Keep this window running while compressing.
echo.

"%NODE_EXE%" server.js
if errorlevel 9009 (
  echo.
  echo   [错误] Node.js 启动失败，请确认已正确安装。
  echo.
)

echo.
echo   Server stopped.
pause

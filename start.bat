@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"

rem ---------------------------------------------------------------
rem  Video Compress Console 一键启动
rem  依次尝试：PATH 里的 node -> 本机常见安装位置
rem ---------------------------------------------------------------
set "NODE_EXE="
rem 0) 完整版包内置的 node.exe（-full.zip 才有，真正做到解压即用）
if exist "%~dp0node.exe" set "NODE_EXE=%~dp0node.exe"
rem 1) PATH 里的 node
if not defined NODE_EXE where node >nul 2>&1 && set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE_EXE (
  echo.
  echo   [错误] 没有找到 Node.js
  echo.
  echo   如果你下的是 -full.zip，包内应自带 node.exe，缺了就是解压不完整，
  echo   重新解压一次即可。其他情况请安装 Node.js 18.15 以上版本：
  echo   https://nodejs.org/
  echo.
  pause
  exit /b 1
)

rem 程序目录自带的 ffmpeg（便携用法：解压到本目录的 ffmpeg\ 下即可）
set "FF_LOCAL="
if exist "%~dp0ffmpeg\bin\ffmpeg.exe" set "FF_LOCAL=%~dp0ffmpeg\bin\ffmpeg.exe"
if not defined FF_LOCAL if exist "%~dp0ffmpeg\ffmpeg.exe" set "FF_LOCAL=%~dp0ffmpeg\ffmpeg.exe"

echo.
echo   Video Compress Console
echo   ==========================================
echo   Node   : %NODE_EXE%
if defined FF_LOCAL echo   ffmpeg : %FF_LOCAL%
if not defined FF_LOCAL echo   ffmpeg : 不在程序目录，启动后按提示指定
echo   ==========================================
if not defined FF_LOCAL echo.
if not defined FF_LOCAL echo   没有 ffmpeg 也能先看看界面：把 ffmpeg 解压到本目录的
if not defined FF_LOCAL echo   ffmpeg\bin\ 下即可自动识别，或在页面「程序设置」里填路径。
if not defined FF_LOCAL echo   下载： https://www.gyan.dev/ffmpeg/builds/  （选 essentials）
if not defined FF_LOCAL echo.
echo   浏览器会自动打开。压缩期间别关这个窗口。
echo.

"%NODE_EXE%" server.js

echo.
echo   Server stopped.
pause

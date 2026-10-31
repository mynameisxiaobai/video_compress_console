这个文件夹放 ffmpeg
====================

■ 完整版（video-compress-console-1.0.0-full.zip）
  什么都不用做。ffmpeg.exe / ffprobe.exe 已经在 ffmpeg\bin\ 下，
  双击 start.bat 就能直接压片。
  · LICENSE         GPLv3 全文（随二进制分发所需）
  · THIRD-PARTY.txt 版本号、编译选项与源码获取地址

■ 精简版（video-compress-console-1.0.0-lite.zip）
  需要自己准备一份 ffmpeg，三步：

  1) 下载（选 essentials 那个 zip，自带 NVENC 与 x265）
     https://www.gyan.dev/ffmpeg/builds/

  2) 解压后，把 bin 里的两个 exe 拷到本目录的 bin\ 下，最终长这样：

     ffmpeg\
     └── bin\
         ├── ffmpeg.exe
         └── ffprobe.exe

     放到本目录（ffmpeg\ffmpeg.exe）也认。
     直接把整个 ffmpeg-x.x-essentials_build 文件夹丢进程序目录，同样能识别。

  3) 重新双击 start.bat。启动窗口会打印实际用到的 ffmpeg 路径，
     页面顶部也会从「ffmpeg 未找到」变成版本号。

已经在本机装过 ffmpeg 并加进 PATH 的，或者放在 C:\ffmpeg\bin 的，可以跳过这一步。
如果装在别处又不想动 PATH：启动后在左侧「程序设置」里填 ffmpeg.exe 的完整路径即可。

# Video Compress Console · 视频压缩控制台

一个跑在本机的 ffmpeg 批量转码控制台：**零依赖**（不用 `npm install`）、单文件前端、双击即用。
把整个剧集文件夹丢进去，它逐文件算出该用的码率，排队压完，跑完的自动折起来。

![主视觉](docs/images/01-batch-compress.png)

## 它解决什么问题

压视频这件事，难的不是压一个，而是**压一批**：

| 痛点 | 这里的做法 |
|---|---|
| ffmpeg 参数记不住 | 画质三档 + 自动码率，参数在「高级参数」里可查可改 |
| 码率给多少全靠猜 | 按 `像素数 × 帧率 × bpp` 逐文件计算，锚点实测 PSNR 46.6 dB |
| 一压一整晚，不知道进度 | SSE 实时推送，每集一段胶片进度条，完成自动折叠 |
| 输出目录乱 | 集中输出，或勾选后自动建在源目录同级的 `xxx_压缩` |
| 4K 文件太大传不上来 | 按短边上限只降不升，源文件始终保持不动 |
| 命令行选文件太痛苦 | 系统选择框、拖拽文件夹、拖拽单文件都支持 |

## 界面

![界面截图](docs/screenshot.png)

左侧选源与参数，右侧是队列。深色暖石墨底 + 钠灯琥珀，进度用「胶片条」表达：一集一段，按时长分宽。

## 快速开始

### 环境要求

- **Node.js 18.15+**（用到了 `fs.statfsSync`，推荐 20 LTS）
- **ffmpeg + ffprobe**：带 `h264_nvenc` 的 NVIDIA 卡可用硬件编码；没有独显会自动走 `libx265`
- Windows 10/11（文件选择框、打开文件夹为 Windows 原生实现）

### 启动

```bat
双击 start.bat
```

或手动：

```bash
node server.js
```

浏览器会自动打开 `http://127.0.0.1:8787`；端口被占用时自动顺延（8788、8789…）。
关掉那个黑色命令行窗口 = 停止服务。

### 首次配置

`config.json` 存放本机路径，已被 `.gitignore` 排除。复制模板改一改：

```bash
cp config.example.json config.json
```

必须确认的一项：`ffmpegPath` 指向你的 `ffmpeg.exe`。也可以在页面右上角的设置里改，保存后即时生效。

## 怎么用

### 1. 选文件，三种方式

- **按钮选择**：`选择视频文件…`（多选）/ `选择文件夹…`，走 Windows 原生对话框
- **拖文件夹**：整个文件夹拖到页面任意位置，会递归扫描（默认 3 层）并全选
- **拖单个视频**：只载入你拖的那几个，不动目录里其他文件

浏览器出于安全限制，`drop` 事件只给出文件名、拿不到磁盘绝对路径。所以拖拽时后端会拿这个名字在本机常见位置做一次广度优先搜索，把它还原回真实文件——这就是下图小黑在干的事：

![拖拽路径还原](docs/images/03-drag-locate.png)

搜索带 6 秒时间预算，根目录按「上次用过的目录 → Downloads/Desktop/Videos → 各盘根」排序。
搜到多个同名候选时会全部列出来让你点；UNC 网络路径不支持，页面会提示改用系统选择框。

### 2. 画质档位与码率

三档对应三个 bpp（bit per pixel per frame）：

| 档位 | bpp | 适合 |
|---|---|---|
| 小体积 | 0.0300 | 存档、移动端看 |
| 均衡 | 0.0414 | 默认，1978×1080@25fps → 2213k |
| 高画质 | 0.0524 | 源质量很好、想少损失 |

码率不是拍脑袋定的，是按内容逐文件称出来的：

![码率模型](docs/images/02-bitrate-scale.png)

```
目标码率 = 缩放后宽 × 缩放后高 × 帧率 × bpp
```

两个关键细节：

- **必须用缩放后的尺寸**。编码器实际编码的就是它；若用源尺寸，4K→1080p 会算出 4293k，直接破坏锚点。
- **码率下限 150k**（`HARD_MIN_K`），防止小分辨率视频被压成糊片。

分辨率按「短边上限」处理，只降不升：1080p 的源配 720p 上限会降到 720p，720p 的源配 1080p 上限则保持 720p。填 `0` 表示不缩放。

### 3. 输出目录，两种模式

- **集中输出**（默认）：统一放到 `outputRoot` 下，按源目录名自动建子目录
- **同级输出**：勾选「输出到源目录同级」，自动在源文件夹旁边新建 `<源文件夹名>_压缩`，源文件一动不动

![同级输出](docs/images/04-beside-output.png)

盘符根目录（如 `E:\`）作为源目录时会自动回退到集中输出，避免拼出 `E:\_压缩` 这种怪路径。

### 4. 任务队列

- 跑完一个自动折叠，只留一行；进行中和失败的保持展开
- 折叠可以手动点开/收起，也能用顶部「全部 / 未完成 / 已完成 / 失败」筛选
- 随时可以取消单个任务；磁盘剩余不足 2 GB 时自动暂停派发
- 出发前会按每个文件的目标码率累加预估体积，空间不够直接拒绝并告诉你差多少

![任务折叠](docs/images/05-job-folding.png)

## 它是怎么工作的

```
┌──────────────┐   HTTP/SSE    ┌─────────────────────────┐
│  public/     │ ◄──────────── │  server.js              │
│  index.html  │               │  ├─ lib/http.js     路由 │
│  (单文件前端) │ ────────────► │  ├─ lib/probe.js    扫描 │
└──────────────┘               │  ├─ lib/bitrate.js  码率 │
                               │  ├─ lib/tasks.js    队列 │
                               │  ├─ lib/locate.js   拖拽 │
                               │  ├─ lib/pick.ps1    对话框│
                               │  └─ lib/disk.js     空间 │
                               └──────────┬──────────────┘
                                          │ spawn
                                   ┌──────▼──────┐
                                   │   ffmpeg    │
                                   └─────────────┘
```

几个实现上的选择：

- **零依赖**。后端只用 Node 内置模块，前端是一个没有构建步骤的 HTML 文件。克隆下来就能跑。
- **进度用 SSE 推**，不用轮询；页面刷新后立刻收到当前快照。
- **容器魔数嗅探**：只读前 12 字节。源文件扩展名是 `.mp4` 但真实容器是 Matroska 时，会在列表里标注，并给 ffmpeg 传正确的 demuxer。
- **字幕**：默认保留并转 `mov_text`；位图字幕（PGS 等）转不了会自动跳过并在日志里说明。
- **`-tag:v hvc1`**：HEVC 输出带 Apple 兼容标签，QuickTime 也能直接放。
- **并发**：NVENC 默认 2（按消费级卡通常双编码器），x265 建议 1–2，可在高级参数里改。

## 目录结构

```
video-compress-console/
├── server.js               # 入口：HTTP 服务 + 全部路由
├── start.bat               # Windows 一键启动（自动找 Node）
├── config.json             # 本机配置（git 忽略）
├── config.example.json     # 配置模板
├── LICENSE                 # MIT
├── lib/
│   ├── http.js             # 极简 HTTP 工具：路由 / JSON / SSE / 静态文件
│   ├── ffmpeg.js           # ffmpeg/ffprobe 定位、能力与版本探测
│   ├── probe.js            # 视频扫描、ffprobe 元数据、容器嗅探
│   ├── bitrate.js          # 码率模型（像素 × 帧率 × bpp）
│   ├── tasks.js            # 任务队列：并发、取消、暂停、进度解析
│   ├── disk.js             # 磁盘空间查询（statfs，中文无乱码）
│   ├── paths.js            # 路径清洗与输出目录推导
│   ├── pick.js             # 调起原生选择框（结果走临时文件回传）
│   ├── pick.ps1            # 上面的 PowerShell 实现
│   └── locate.js           # 拖拽名字 → 真实路径搜索
├── public/
│   └── index.html          # 整个前端（1800+ 行，无构建）
└── docs/
    ├── screenshot.png
    └── images/             # README 配图
```

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `ffmpegPath` | `~\tools\ffmpeg\bin\ffmpeg.exe` | ffmpeg 可执行文件路径 |
| `ffprobePath` | `null` | 留空则自动取 ffmpeg 同目录的 ffprobe |
| `port` | `8787` | 端口，占用自动 +1 重试（最多 10 次） |
| `sourceDir` | — | 上次使用的源目录 |
| `outputRoot` | `E:\压缩完成` | 集中输出的根目录 |
| `encoder` | `nvenc` | `nvenc` 或 `x265` |
| `maxShortSide` | `1080` | 短边上限，只降不升，`0` = 不缩放 |
| `rateMode` | `auto` | `auto` 按内容计算 / `fixed` 用固定值 |
| `qualityTier` | `balanced` | `small` / `balanced` / `high` |
| `videoBitrate` | `2213k` | `rateMode=fixed` 时使用 |
| `audioBitrate` | `192k` | 音频码率 |
| `nvencPreset` | `p6` | NVENC 预设（p1 最快 … p7 最慢） |
| `x265Preset` | `medium` | x265 预设 |
| `aqStrength` | `8` | NVENC 自适应量化强度 |
| `rcLookahead` | `0` | NVENC 前视帧数，`0` = 关 |
| `bref` | `false` | NVENC 是否以参考帧编码 B 帧 |
| `keepSubtitle` | `true` | 保留字幕并转 `mov_text` |
| `vbv` | `true` | 启用 VBV，防止播放器卡顿 |
| `faststart` | `false` | moov 前移，便于在线播放 |
| `multipass` | `true` | NVENC 二轮编码 |
| `concurrency` | `2` | 同时转码任务数 |
| `suffix` | `''` | 输出文件名附加后缀 |
| `besideSource` | `false` | 输出到源目录同级的 `xxx_压缩` |

## HTTP API

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/status` | 配置、ffmpeg 能力、盘符列表 |
| POST | `/api/config` | 保存配置（增量合并） |
| GET | `/api/drives` | 盘符与输出根 |
| GET | `/api/browse?path=` | 目录浏览 |
| POST | `/api/pick` | 弹原生选择框（长请求，选完才返回） |
| POST | `/api/locate` | 拖拽定位：名字 → 候选目录 |
| POST | `/api/probe` | 扫描目录并探测元数据（支持 `recursive`） |
| POST | `/api/jobs` | 创建任务（含磁盘预检） |
| GET | `/api/jobs` | 任务快照 |
| POST | `/api/jobs/:id/cancel` | 取消任务 |
| POST | `/api/resume` | 恢复被空间暂停的派发 |
| GET | `/api/events` | SSE 事件流 |
| POST | `/api/open` | 用资源管理器打开目录 / 选中文件 |
| GET | `/api/log?id=` | 任务详情与完整 ffmpeg 命令 |

## 已知限制

- **监听 `127.0.0.1`，无鉴权**。设计为单机个人使用，不要暴露到局域网。
- 文件选择、打开文件夹是 Windows 实现；转码核心跨平台，但完整体验请在 Windows 上用。
- 拖拽定位有时间预算（约 6 秒），文件在深层目录或网络盘上可能搜不到——这时用按钮选择。
- 位图字幕（PGS/VobSub）无法转 `mov_text`，会跳过并记录。

## FAQ

**Q：启动提示找不到 ffmpeg？**
页面右上角设置里指定 `ffmpeg.exe` 路径，或把它加进 PATH。首次启动若路径不存在，页面会提示。

**Q：没有 NVIDIA 显卡能用吗？**
可以。页面设置里把编码器切成 `x265`，纯 CPU 编码，速度慢但画质可控。启动日志里会显示 `NVENC=不可用 x265=可用`。

**Q：为什么码率和别的软件给的不一样？**
因为它是按这个片源的分辨率、帧率单独算的，不同文件结果不同。想要固定值就在设置里把码率模式切成「固定」。

**Q：源文件会被改动吗？**
不会。全程只读源文件，输出写到 `outputRoot` 或同级的 `_压缩` 目录。

**Q：想改端口？**
改 `config.json` 的 `port`。如果被占用，服务会自动往后试 10 个端口并在启动日志里说明实际用了哪个。

## License

[MIT](LICENSE)

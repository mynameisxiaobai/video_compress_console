param(
  [string]$Mode = 'file',
  [string]$InitialDir = '',
  [string]$OutFile = '',
  [string]$Purpose = ''
)

# 弹出 Windows 原生文件/文件夹选择框，把结果按行写入 $OutFile（UTF-8 无 BOM）。
# 注意：不依赖 stdout 回传中文路径——Windows 控制台是 GBK，回传会乱码。

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$result = @()

# 目标目录可能还不存在（输出目录尤其如此）。直接传给对话框会被忽略，
# 窗口就停在默认位置，用户得自己一路点过去。所以退到最近的已存在祖先。
function Resolve-StartDir([string]$p) {
  if ([string]::IsNullOrWhiteSpace($p)) { return '' }
  try {
    if (Test-Path -LiteralPath $p) { return $p }
    $d = $p
    for ($i = 0; $i -lt 8; $i++) {
      $parent = Split-Path -LiteralPath $d -Parent
      if (-not $parent -or $parent -eq $d) { break }
      $d = $parent
      if (Test-Path -LiteralPath $d) { return $d }
    }
  } catch { }
  return ''
}

$startDir = Resolve-StartDir $InitialDir

# 宿主窗体：只为了让对话框置顶显示，自身不出现在任务栏
$owner = $null
try {
  $owner = New-Object System.Windows.Forms.Form
  $owner.TopMost = $true
  $owner.ShowInTaskbar = $false
  $owner.WindowState = 'Minimized'
  $owner.Opacity = 0.01
  $owner.Show()
  $owner.Hide()
} catch {
  $owner = $null
}

try {
  if ($Mode -eq 'folder') {
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    if ($Purpose -eq 'out') {
      $dlg.Description = '选择压缩结果要存放的文件夹'
      $dlg.ShowNewFolderButton = $true
    } else {
      $dlg.Description = '选择包含视频文件的文件夹'
      $dlg.ShowNewFolderButton = $false
    }
    if ($startDir) {
      $dlg.SelectedPath = $startDir
    }
    if ($owner) { $res = $dlg.ShowDialog($owner) } else { $res = $dlg.ShowDialog() }
    if ($res -eq [System.Windows.Forms.DialogResult]::OK) {
      $result += $dlg.SelectedPath
    }
  } else {
    $dlg = New-Object System.Windows.Forms.OpenFileDialog
    $dlg.Title = '选择要压缩的视频文件（按住 Ctrl / Shift 可多选）'
    $dlg.Multiselect = $true
    $dlg.CheckFileExists = $true
    $dlg.CheckPathExists = $true
    $dlg.Filter = '视频文件|*.mp4;*.mkv;*.mov;*.m4v;*.avi;*.ts;*.flv;*.wmv;*.webm;*.rmvb;*.rm;*.mpg;*.mpeg;*.m2ts|所有文件|*.*'
    $dlg.FilterIndex = 1
    if ($startDir) {
      $dlg.InitialDirectory = $startDir
    }
    if ($owner) { $res = $dlg.ShowDialog($owner) } else { $res = $dlg.ShowDialog() }
    if ($res -eq [System.Windows.Forms.DialogResult]::OK) {
      $result += $dlg.FileNames
    }
  }
} finally {
  if ($owner) { try { $owner.Dispose() } catch {} }
}

if ($OutFile) {
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllLines($OutFile, $result, $enc)
}

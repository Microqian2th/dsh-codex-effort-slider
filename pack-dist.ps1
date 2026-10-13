<#
  打发布包：dist/better-dsh-codex-effort-slider-<version>.zip

  结构与上游发布包保持一致：**zip 里是一层同名目录**，解开后那一层目录即可作为
  DSH Desktop「设置 → 插件 → 添加插件」要填的本地目录路径。

  用法：
    npm run pack                      # 运行时包（只有跑起来需要的文件）
    npm run pack:src                  # 源码包（源码 + 构建 + 离线断言 + 文档）
    # 或（Windows PowerShell 5.1 / pwsh 都行）
    powershell -NoProfile -ExecutionPolicy Bypass -File ./pack-dist.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File ./pack-dist.ps1 -Source

  两种包共用同一套 zip 写入 + 校验逻辑：
    · 默认（运行时包）打进去的文件 = package.json 的 `files` 字段 + package.json 自己（与 npm 发布一致）
    · `-Source` 打进去的是**源码发行版**清单（`$srcList`）：源码、构建脚本、离线断言、文档；
      排除 dist/（产物不套娃）与 preview/*.png（图不必带）。

  ⚠️ 本文件必须存为 **UTF-8 带 BOM**：Windows PowerShell 5.1 读无 BOM 的 .ps1 会按系统
     代码页解码，下面的中文注释与提示会变成乱码、脚本直接语法错误。
#>
[CmdletBinding()]
param(
  # 打**源码包**（<name>-<version>-src.zip）而不是精简的运行时包。
  [switch]$Source
)

$ErrorActionPreference = "Stop"

$root = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$manifestPath = Join-Path $root "package.json"
if (-not (Test-Path $manifestPath)) { throw "找不到 package.json：$manifestPath" }

$pkg = Get-Content $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json
$name = $pkg.name
$version = $pkg.version
if (-not $name -or -not $version) { throw "package.json 里缺 name 或 version" }

$dist = Join-Path $root "dist"
$stage = Join-Path $dist $name
$suffix = if ($Source) { "-src" } else { "" }
$zip = Join-Path $dist "$name-$version$suffix.zip"

Write-Host "`n=== 打$(if ($Source) { '源码包' } else { '发布包' }) ===" -ForegroundColor Cyan
Write-Host "  包名/版本 : $name@$version"
Write-Host "  输出      : $zip"

# ── 1) 摆一份干净的暂存目录（顺便把"列了但不存在"暴露出来）──
#   默认走 package.json 的 `files`（与 npm 发布一致）；`-Source` 走下面的源码发行版清单。
$srcList = @(
  "package.json",
  "cordis.patch.yml",
  "lib/index.js",
  "lib/client.js",
  "lib/client.picker.src.js",
  "lib/client.picker.js",
  "build/pack-picker.mjs",
  "test/harness.mjs",
  "test/client.test.mjs",
  "preview/make-preview.mjs",
  "preview/panel.html",
  "install.cmd",
  "install-profile.ps1",
  "pack-dist.ps1",
  "README.md",
  "MODIFICATIONS.md",
  "CHANGELOG.md",
  "LICENSE"
)
$list = if ($Source) { $srcList } else { (@($pkg.files) + @("package.json")) }

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

foreach ($item in $list) {
  $from = Join-Path $root $item
  if (-not (Test-Path $from)) { throw "清单里列了 $item，但仓库里没有 —— 先补上或从清单里删掉" }
  $to = Join-Path $stage $item
  $toDir = Split-Path -Parent $to
  if (-not (Test-Path $toDir)) { New-Item -ItemType Directory -Force -Path $toDir | Out-Null }
  Copy-Item -LiteralPath $from -Destination $to -Recurse -Force
}

# ── 2) 压缩 ──
# 不用 ZipFile::CreateFromDirectory：.NET Framework 的实现（PS 5.1 用的就是它）会把条目名
# 写成 `a\b\c`（反斜杠）。ZIP 规范要求 `/`，反斜杠在 macOS/Linux 解压时会变成文件名的一部分。
# 所以自己建条目、路径统一用 `/`，顺带保留修改时间。
# ZipArchive / ZipArchiveMode / CompressionLevel 在 System.IO.Compression，
# ZipFile 在 System.IO.Compression.FileSystem —— 两个都要显式加载
# （PS 5.1 的按需加载不总生效，缺一个就报 "Unable to find type"）。
foreach ($asm in @("System.IO.Compression", "System.IO.Compression.FileSystem")) {
  try { Add-Type -AssemblyName $asm -ErrorAction Stop } catch { }
}
if (Test-Path $zip) { Remove-Item $zip -Force }

$archive = [System.IO.Compression.ZipFile]::Open($zip, [System.IO.Compression.ZipArchiveMode]::Create)
$count = 0
try {
  foreach ($file in (Get-ChildItem -LiteralPath $stage -Recurse -File | Sort-Object FullName)) {
    $rel = $file.FullName.Substring($stage.Length + 1).Replace('\', '/')
    $entry = $archive.CreateEntry("$name/$rel", [System.IO.Compression.CompressionLevel]::Optimal)
    $entry.LastWriteTime = $file.LastWriteTime
    $out = $entry.Open()
    try {
      $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
      $out.Write($bytes, 0, $bytes.Length)
    } finally {
      $out.Dispose()
    }
    $count += 1
  }
} finally {
  $archive.Dispose()
}

# ── 3) 校验 + 留一份哈希（发布时可以直接贴）──
$check = [System.IO.Compression.ZipFile]::OpenRead($zip)
try {
  $names = $check.Entries | Where-Object { $_.Name -ne "" } | ForEach-Object { $_.FullName }
  $roots = @($names | ForEach-Object { ($_ -split '/')[0] } | Sort-Object -Unique)
  if ($roots.Count -ne 1 -or $roots[0] -ne $name) {
    throw "zip 里的根目录不是单一目录 $name（实际：$($roots -join ', ')）—— 解压后拿不到可填的插件目录"
  }
  $bad = $names | Where-Object { $_ -match '\\' }
  if ($bad) { throw "zip 条目名里还有反斜杠：$($bad[0])" }
} finally {
  $check.Dispose()
}

$hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
$kb = [math]::Round((Get-Item -LiteralPath $zip).Length / 1KB, 1)
# 两种包的哈希都留在同一份清单里（同一个包重打时替换自己那一行，不累积重复）
$sumPath = Join-Path $dist "SHA256SUMS.txt"
$zipName = "$name-$version$suffix.zip"
$kept = @()
if (Test-Path $sumPath) {
  $kept = @(Get-Content -LiteralPath $sumPath -Encoding ascii | Where-Object { $_ -and $_ -notmatch [regex]::Escape($zipName) })
}
($kept + "$hash  $zipName") | Set-Content -LiteralPath $sumPath -Encoding ascii

Write-Host "  条目      : $count 个文件，根目录 $name/"
Write-Host "  大小      : $kb KB"
Write-Host "  SHA256    : $hash"
Write-Host "`n打好了 ✅  $zip`n" -ForegroundColor Green

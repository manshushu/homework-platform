# ==============================================================
# 课堂作业收发平台 - 服务启动与状态控制
# ==============================================================

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Host.UI.RawUI.WindowTitle = "课堂作业收发平台 - 服务运行中"

Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host "             课堂作业收发平台 (发作业与收作业专用)               " -ForegroundColor Green
Write-Host "=================================================================" -ForegroundColor Cyan

$AppDir = Split-Path -Parent $PSScriptRoot
Set-Location $AppDir

# 1. 检测 Node.js 运行时
try {
    $nodeVer = node -v 2>$null
    if (-not $nodeVer) {
        Write-Host "【错误】未检测到 Node.js 运行环境！" -ForegroundColor Red
        Write-Host "请先安装 Node.js (推荐 v18 或更高版本)，官网下载: https://nodejs.org/" -ForegroundColor Yellow
        Write-Host ""
        Read-Host "按回车键退出..."
        exit 1
    }
    Write-Host "✔ Node.js 环境检测通过: $nodeVer" -ForegroundColor Green
} catch {
    Write-Host "【错误】检测 Node.js 异常: $_" -ForegroundColor Red
    Read-Host "按回车键退出..."
    exit 1
}

# 2. 检查依赖包完整性
if (-not (Test-Path "$AppDir\node_modules")) {
    Write-Host "首次运行，正在自动安装必要依赖，请稍候..." -ForegroundColor Yellow
    npm install --omit=dev
}

# 3. 提取本地局域网 IP
$ipList = @()
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notmatch 'Loopback' -and $_.IPAddress -notmatch '^169\.254' } | ForEach-Object {
    $ipList += $_.IPAddress
}

Write-Host "-----------------------------------------------------------------" -ForegroundColor Gray
Write-Host "【教师管理后台】: http://localhost:3000/teacher" -ForegroundColor Cyan
Write-Host "【学生交作业地址】(投屏给学生，学生在机房浏览器打开即可):" -ForegroundColor Yellow
foreach ($ip in $ipList) {
    Write-Host "  👉 http://$($ip):3000" -ForegroundColor Green
}
Write-Host "-----------------------------------------------------------------" -ForegroundColor Gray
Write-Host "提示：保持此窗口常开，学生即可随时交作业与下载资料。按 Ctrl+C 可停止服务。" -ForegroundColor Magenta
Write-Host ""

# 自动在默认浏览器中打开教师端
Start-Process "http://localhost:3000/teacher"

# 启动 Node 服务
node "$AppDir\server\index.js"
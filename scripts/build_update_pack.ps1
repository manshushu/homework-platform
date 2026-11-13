[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$RootDir = Split-Path -Parent $PSScriptRoot
Set-Location $RootDir

$Stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$DistBase = Join-Path $RootDir 'dist_update'
$PackName = "作业收发平台_升级包_$Stamp"
$PackDir = Join-Path $DistBase $PackName
$ZipPath = Join-Path $DistBase "$PackName.zip"

Write-Host '=================================================================' -ForegroundColor Cyan
Write-Host '           课堂作业收发平台 - 生成服务器升级包工具               ' -ForegroundColor Green
Write-Host '=================================================================' -ForegroundColor Cyan

New-Item -ItemType Directory -Path $PackDir -Force | Out-Null

foreach ($sub in @('public', 'server', 'scripts')) {
    $srcSub = Join-Path $RootDir $sub
    $dstSub = Join-Path $PackDir $sub
    if (Test-Path $srcSub) {
        $null = robocopy $srcSub $dstSub /MIR /NFL /NDL /NJH /NJS /NC /NS
        if ($LASTEXITCODE -ge 8) {
            throw "复制目录 $sub 失败"
        }
    }
}

$rootFiles = @(
    'package.json', 'package-lock.json', 'start.bat',
    '查看与管理后台服务.bat', '启动作业收发平台.exe',
    '交作业入口.html', '使用说明与部署指南.md',
    '一键升级部署.bat', '一键升级部署.exe'
)
foreach ($rf in $rootFiles) {
    $srcFile = Join-Path $RootDir $rf
    if (Test-Path $srcFile) {
        Copy-Item -Path $srcFile -Destination (Join-Path $PackDir $rf) -Force
    }
}

if (Test-Path $ZipPath) {
    Remove-Item $ZipPath -Force
}
Compress-Archive -Path "$PackDir\*" -DestinationPath $ZipPath -CompressionLevel Optimal

Write-Host "✔ 升级包目录已生成: $PackDir" -ForegroundColor Green
Write-Host "✔ 升级包压缩包已生成: $ZipPath" -ForegroundColor Green
Write-Host ''
Write-Host '使用方法: 把上述压缩包或文件夹复制到内网服务器解压后，双击“一键升级部署.exe”即可自动完成停旧服、备份、更新、迁移与重启。' -ForegroundColor Yellow
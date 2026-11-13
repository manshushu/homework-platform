[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$SourceDir = Split-Path -Parent $PSScriptRoot
$TaskName = 'HomeworkPlatformServer'

function Test-IsAdmin {
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

function Stop-PlatformProcesses {
    Write-Host '[2/6] 正在停止旧服务与占用 3000 端口的进程...' -ForegroundColor Yellow
    try {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($task) {
            Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        }
    } catch {}

    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.CommandLine -and $_.CommandLine -like '*run_service.ps1*') {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }

    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.CommandLine -and $_.CommandLine -like '*server*index.js*') {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }

    $tcpPids = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($procId in $tcpPids) {
        if ($procId -and $procId -ne 0) {
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        }
    }

    Start-Sleep -Seconds 2
    Write-Host '  ✔ 旧服务已停止' -ForegroundColor Green
}

Write-Host '=================================================================' -ForegroundColor Cyan
Write-Host '          课堂作业收发平台 - 内网服务器一键升级部署工具          ' -ForegroundColor Green
Write-Host '=================================================================' -ForegroundColor Cyan
Write-Host "当前升级包目录: $SourceDir" -ForegroundColor Gray

if (-not (Test-IsAdmin)) {
    Write-Host '【提示】当前不是管理员权限，若需注册/重启系统计划任务，请双击“一键升级部署.exe”。' -ForegroundColor Yellow
}

# 1. Determine target deployment directory
$DetectedTarget = $null
try {
    $existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existingTask) {
        $exePath = ($existingTask.Actions | Select-Object -First 1).Execute
        if ($exePath -and (Test-Path $exePath)) {
            $DetectedTarget = Split-Path -Parent (Split-Path -Parent $exePath)
        }
    }
} catch {}

if (-not $DetectedTarget) {
    $DetectedTarget = $SourceDir
}

Write-Host ''
Write-Host '[1/6] 请确认服务器上的部署目录（将保留该目录下的全部学生作业、名单和数据库）：' -ForegroundColor Cyan
Write-Host "  检测到的默认目录: $DetectedTarget" -ForegroundColor Yellow
$inputTarget = Read-Host '直接按回车使用默认目录，或输入新的目标目录路径'
$TargetDir = if ([string]::IsNullOrWhiteSpace($inputTarget)) { $DetectedTarget } else { $inputTarget.Trim().Trim('"') }

if (-not (Test-Path $TargetDir)) {
    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
}
$TargetDir = (Resolve-Path $TargetDir).Path
Write-Host "  ✔ 目标部署目录: $TargetDir" -ForegroundColor Green

# 2. Stop old services
Stop-PlatformProcesses

# 3. Backup existing database
Write-Host '[3/6] 正在备份现有数据库与配置...' -ForegroundColor Yellow
$TargetStorage = Join-Path $TargetDir 'storage'
$TargetDb = Join-Path $TargetStorage 'homework_platform.db'
if (Test-Path $TargetDb) {
    $BackupDir = Join-Path $TargetStorage ('backups\upgrade_' + (Get-Date -Format 'yyyyMMdd_HHmmss'))
    New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
    Copy-Item -Path (Join-Path $TargetStorage 'homework_platform.db*') -Destination $BackupDir -Force -ErrorAction SilentlyContinue
    Write-Host "  ✔ 数据库已备份至: $BackupDir" -ForegroundColor Green
} else {
    Write-Host '  ✔ 首次部署，暂无需备份的旧数据库' -ForegroundColor Gray
}

# 4. Sync code files without touching storage or node_modules
Write-Host '[4/6] 正在同步新版程序文件（保留 storage 与 node_modules）...' -ForegroundColor Yellow
if ($SourceDir.TrimEnd('\') -ine $TargetDir.TrimEnd('\')) {
    foreach ($sub in @('public', 'server', 'scripts')) {
        $srcSub = Join-Path $SourceDir $sub
        $dstSub = Join-Path $TargetDir $sub
        if (Test-Path $srcSub) {
            $null = robocopy $srcSub $dstSub /MIR /NFL /NDL /NJH /NJS /NC /NS
            if ($LASTEXITCODE -ge 8) {
                throw "同步目录 $sub 失败，robocopy 退出码: $LASTEXITCODE"
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
        $srcFile = Join-Path $SourceDir $rf
        if (Test-Path $srcFile) {
            Copy-Item -Path $srcFile -Destination (Join-Path $TargetDir $rf) -Force
        }
    }
    Write-Host '  ✔ 程序文件同步完成' -ForegroundColor Green
} else {
    Write-Host '  ✔ 源目录与目标目录相同，跳过复制步骤' -ForegroundColor Gray
}

# 5. Verify Node.js, dependencies, syntax, and DB migration
Write-Host '[5/6] 正在执行语法检查与数据库结构自检...' -ForegroundColor Yellow
Set-Location $TargetDir
$nodeCmd = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $nodeCmd) {
    $nodeCmd = 'C:\Program Files\nodejs\node.exe'
}
if (-not (Test-Path $nodeCmd)) {
    throw '未检测到 Node.js，请先在服务器上安装 Node.js (v18+)'
}

if (-not (Test-Path (Join-Path $TargetDir 'node_modules'))) {
    Write-Host '  未检测到 node_modules，正在尝试 npm install --omit=dev...' -ForegroundColor Yellow
    npm install --omit=dev
}

foreach ($jsFile in @('server\index.js', 'server\db.js', 'server\routes\api.js', 'public\js\app.js', 'public\js\teacher.js')) {
    if (Test-Path $jsFile) {
        & $nodeCmd -c $jsFile
        if ($LASTEXITCODE -ne 0) { throw "语法检查失败: $jsFile" }
    }
}

& $nodeCmd -e "require('./server/db'); console.log('DB_MIGRATION_OK');"
if ($LASTEXITCODE -ne 0) { throw '数据库初始化或平滑迁移失败' }
Write-Host '  ✔ 语法校验与数据库自检通过' -ForegroundColor Green

# 6. Register/start scheduled task and verify HTTP health
Write-Host '[6/6] 正在启动新版本服务并执行端口健康测试...' -ForegroundColor Yellow
$RunBat = Join-Path $TargetDir 'scripts\run_service.bat'
$startedByTask = $false

if (Test-IsAdmin) {
    $action = New-ScheduledTaskAction -Execute $RunBat -WorkingDirectory (Split-Path -Parent $RunBat)
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    $startedByTask = $true
} else {
    Start-Process -FilePath 'cmd.exe' -ArgumentList "/c `"$RunBat`"" -WorkingDirectory (Split-Path -Parent $RunBat) -WindowStyle Hidden
}

$ready = $false
for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 1
    if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) {
        $ready = $true
        break
    }
}

if (-not $ready) {
    throw '服务启动超时，3000 端口未就绪，请检查 storage\logs\server_stderr.log'
}

$health = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/info' -TimeoutSec 5
if (-not $health.success) {
    throw '接口健康检查未通过 (/api/info)'
}

Write-Host ''
Write-Host '=================================================================' -ForegroundColor Cyan
Write-Host '  🎉 升级部署成功！新版本已启动并通过健康检查！' -ForegroundColor Green
Write-Host "  运行模式: $(if ($startedByTask) { '系统后台计划任务 (HomeworkPlatformServer)' } else { '当前用户后台进程' })" -ForegroundColor Gray
Write-Host "  教师后台: http://localhost:3000/teacher" -ForegroundColor Cyan
Write-Host "  学生访问: $($health.data.primaryUrl)" -ForegroundColor Yellow
Write-Host '=================================================================' -ForegroundColor Cyan
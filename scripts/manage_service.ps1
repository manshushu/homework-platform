[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Host.UI.RawUI.WindowTitle = "课堂作业收发平台 - 后台服务管理"
$AppDir = Split-Path -Parent $PSScriptRoot
$TaskName = "HomeworkPlatformServer"
$RunBat = Join-Path $AppDir "scripts\run_service.bat"

function Test-IsAdmin {
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

function Stop-HomeworkNode {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.CommandLine -and $_.CommandLine -like "*server*index.js*") {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
}

function Ensure-ScheduledTask {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $needRegister = $false
    if (-not $task) {
        $needRegister = $true
        Write-Host "未检测到计划任务 ($TaskName)，准备自动注册..." -ForegroundColor Yellow
    } else {
        $currentExe = ($task.Actions | Select-Object -First 1).Execute
        if ($currentExe -ne $RunBat) {
            $needRegister = $true
            Write-Host "检测到计划任务路径与当前目录不一致，准备更新..." -ForegroundColor Yellow
        }
    }

    if (-not $needRegister) {
        return $true
    }

    if (-not (Test-IsAdmin)) {
        Write-Host "注册或更新系统后台服务需要管理员权限。" -ForegroundColor Red
        Write-Host "请关闭窗口后，右键“查看与管理后台服务.bat”选择“以管理员身份运行”。" -ForegroundColor Yellow
        return $false
    }

    if (-not (Test-Path $RunBat)) {
        Write-Host "未找到启动脚本: $RunBat" -ForegroundColor Red
        return $false
    }

    try {
        $action = New-ScheduledTaskAction -Execute $RunBat -WorkingDirectory (Split-Path -Parent $RunBat)
        $trigger = New-ScheduledTaskTrigger -AtStartup
        $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
        Write-Host "已成功注册开机自启后台服务 ($TaskName)。" -ForegroundColor Green
        return $true
    } catch {
        Write-Host "注册计划任务失败: $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
}

function Show-Status {
    Write-Host ""
    Write-Host "==================================================" -ForegroundColor Cyan
    Write-Host "  课堂作业收发平台 - 持久化后台服务状态" -ForegroundColor Green
    Write-Host "==================================================" -ForegroundColor Cyan
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        $taskExe = ($task.Actions | Select-Object -First 1).Execute
        if ($taskExe -eq $RunBat) {
            Write-Host "计划任务状态: $($task.State)" -ForegroundColor Yellow
        } else {
            Write-Host "计划任务状态: $($task.State) (路径需更新，按 1 启动时将自动修正)" -ForegroundColor Yellow
        }
    } else {
        Write-Host "计划任务状态: 未安装 ($TaskName) - 按 1 启动时将自动注册" -ForegroundColor Yellow
    }

    $tcp = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
    if ($tcp) {
        Write-Host "3000 端口监听: 正常 (PID: $($tcp.OwningProcess -join ','))" -ForegroundColor Green
    } else {
        Write-Host "3000 端口监听: 未监听" -ForegroundColor Red
    }

    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceAlias -notmatch 'Loopback' -and $_.IPAddress -notmatch '^169\.254' } | ForEach-Object {
        Write-Host "访问地址: http://$($_.IPAddress):3000  (教师端: /teacher)" -ForegroundColor Cyan
    }
    Write-Host "--------------------------------------------------" -ForegroundColor Gray
}

while ($true) {
    Show-Status
    Write-Host "请选择操作: [1] 启动/重启服务  [2] 停止服务  [3] 查看最近日志  [0] 退出"
    $choice = Read-Host "输入数字"
    if ($choice -eq '1') {
        $ready = Ensure-ScheduledTask
        if (-not $ready) {
            continue
        }
        try {
            Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
            Stop-HomeworkNode
            Start-Sleep -Seconds 1
            Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
            Write-Host "正在启动服务，请稍候..." -ForegroundColor Cyan
            $started = $false
            for ($i = 0; $i -lt 5; $i++) {
                Start-Sleep -Seconds 1
                if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) {
                    $started = $true
                    break
                }
            }
            if ($started) {
                Write-Host "服务启动成功，3000 端口已开始监听。" -ForegroundColor Green
            } else {
                Write-Host "已触发启动，但暂未检测到 3000 端口监听，请按 3 查看日志排查。" -ForegroundColor Yellow
            }
        } catch {
            Write-Host "启动服务失败: $($_.Exception.Message)" -ForegroundColor Red
            if (-not (Test-IsAdmin)) {
                Write-Host "提示：请右键“查看与管理后台服务.bat”选择“以管理员身份运行”。" -ForegroundColor Yellow
            }
        }
    } elseif ($choice -eq '2') {
        try {
            Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
            Stop-HomeworkNode
            Start-Sleep -Seconds 1
            Write-Host "已停止服务。" -ForegroundColor Yellow
        } catch {
            Write-Host "停止服务失败: $($_.Exception.Message)" -ForegroundColor Red
        }
    } elseif ($choice -eq '3') {
        $logFile = Join-Path $AppDir 'storage\logs\service.log'
        $errFile = Join-Path $AppDir 'storage\logs\server_stderr.log'
        if (Test-Path $logFile) {
            Write-Host "--- service.log (最近20行) ---" -ForegroundColor Cyan
            Get-Content $logFile -Tail 20 -Encoding UTF8
        } else {
            Write-Host "暂无 service.log。" -ForegroundColor Yellow
        }
        if ((Test-Path $errFile) -and ((Get-Item $errFile).Length -gt 0)) {
            Write-Host "--- server_stderr.log (最近20行) ---" -ForegroundColor Yellow
            Get-Content $errFile -Tail 20 -Encoding UTF8
        }
    } elseif ($choice -eq '0') {
        break
    }
}

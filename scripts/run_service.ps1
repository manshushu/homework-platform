$ErrorActionPreference = 'Continue'
$AppDir = Split-Path -Parent $PSScriptRoot
Set-Location $AppDir

$LogDir = Join-Path $AppDir 'storage\logs'
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}
$ServiceLog = Join-Path $LogDir 'service.log'
$OutLog = Join-Path $LogDir 'server_stdout.log'
$ErrLog = Join-Path $LogDir 'server_stderr.log'

function Write-SvcLog($msg) {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $ServiceLog -Value "[$ts] $msg" -Encoding UTF8
}

function Rotate-Log($path, $maxBytes) {
    if ((Test-Path $path) -and ((Get-Item $path).Length -gt $maxBytes)) {
        $bak = "$path.old"
        if (Test-Path $bak) { Remove-Item $bak -Force -ErrorAction SilentlyContinue }
        Move-Item $path $bak -Force -ErrorAction SilentlyContinue
    }
}

Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.CommandLine -and $_.CommandLine -like "*server*index.js*") {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

$nodeCmd = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $nodeCmd) {
    $nodeCmd = 'C:\Program Files\nodejs\node.exe'
}

Write-SvcLog "Watchdog started. AppDir=$AppDir Node=$nodeCmd"

while ($true) {
    Rotate-Log $ServiceLog 5MB
    Rotate-Log $OutLog 10MB
    Rotate-Log $ErrLog 10MB

    Write-SvcLog "Starting server\index.js..."
    $proc = Start-Process -FilePath $nodeCmd `
        -ArgumentList 'server\index.js' `
        -WorkingDirectory $AppDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $OutLog `
        -RedirectStandardError $ErrLog `
        -PassThru

    $proc.WaitForExit()
    Write-SvcLog "node.exe exited with code $($proc.ExitCode). Restarting in 3s..."
    Start-Sleep -Seconds 3
}
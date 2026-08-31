# tools/run-aria2.ps1
param(
  [string]$AriaPath = "",
  [int]$RpcPort = 6800
)

$ErrorActionPreference = 'Continue'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir

if (-not $AriaPath -or -not (Test-Path $AriaPath)) {
  $found = Get-ChildItem -Path (Join-Path $projectRoot 'tools') -Recurse -Filter 'aria2c.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) {
    $AriaPath = $found.FullName
  } else {
    Write-Host "ERROR: aria2c.exe not found in $projectRoot\tools" -ForegroundColor Red
    exit 1
  }
} else {
  $AriaPath = (Resolve-Path $AriaPath).Path
}

$workingDir = Split-Path -Parent $AriaPath
$logDir = Join-Path $workingDir 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logPath = Join-Path $logDir 'aria2.log'

# Windows-safe, high-throughput RPC options
$rpcArgs = @(
  '--enable-rpc=true',
  '--rpc-listen-all=false',
  '--rpc-allow-origin-all=true',
  "--rpc-listen-port=$RpcPort",
  '--max-concurrent-downloads=16',
  '--split=64',
  '--max-connection-per-server=16',
  '--min-split-size=1M',
  '--piece-length=1M',
  '--socket-recv-buffer-size=8M',
  '--disk-cache=256M',
  '--file-allocation=none',
  '--stream-piece-selector=geom',
  '--async-dns=true',
  '--async-dns-server=1.1.1.1,8.8.8.8',
  '--http-accept-gzip=true',
  '--http-no-cache=true',
  '--optimize-concurrent-downloads=true',
  '--conditional-get=true',
  '--lowest-speed-limit=0',
  '--max-overall-download-limit=0',
  '--max-download-limit=0',
  "--log=$logPath",
  '--log-level=notice'
)

Write-Host "=== LSDM aria2 supervisor ==="
Write-Host "aria2 path: $AriaPath"
Write-Host "Log file:   $logPath"
Write-Host ""

$restartCount = 0
while ($true) {
  $restartCount++
  $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Write-Host "[$timestamp] Starting aria2 (attempt $restartCount)..."

  # Start directly with visible output on crash
  $proc = Start-Process -FilePath $AriaPath -ArgumentList $rpcArgs -WorkingDirectory $workingDir -PassThru -Wait -NoNewWindow

  $exitCode = $proc.ExitCode
  if ($exitCode -eq 0) {
    Write-Host "aria2 stopped normally." -ForegroundColor Yellow
    break
  }
  
  Write-Host "aria2 exited with code $exitCode. Check log: $logPath" -ForegroundColor Red
  Write-Host "Restarting in 3 seconds... (Press Ctrl+C to cancel)"
  Start-Sleep -Seconds 3
}
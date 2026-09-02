# install-aria2.ps1
# Attempts to download the latest aria2 Windows release, extract to tools\aria2, and start aria2 with RPC enabled.
# Run from the project root in PowerShell (no admin required for local tools folder).

$ErrorActionPreference = 'Stop'
$toolsDir = Join-Path -Path (Get-Location) -ChildPath 'tools'
$ariaDir = Join-Path -Path $toolsDir -ChildPath 'aria2'
$zipPath = Join-Path -Path $toolsDir -ChildPath 'aria2_latest.zip'
$RpcPort = 6800

# Conflict detection: a second aria2 won't be able to bind RPC. Probe
# locally first so we don't drop the user into an infinite 3-second
# restart loop when LSDM (or another install) already owns the daemon.
function Test-Aria2Alive {
  param([int]$Port)
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(500)
    if ($ok) {
      $client.EndConnect($iar)
      $client.Close()
      return $true
    }
    $client.Close()
  } catch {}
  return $false
}

if (-Not (Test-Path $toolsDir)) { New-Item -ItemType Directory -Path $toolsDir | Out-Null }

# If aria2 is already installed locally, reuse it instead of downloading every time.
$existingAriaExe = Get-ChildItem -Path $ariaDir -Recurse -Filter 'aria2c.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existingAriaExe) {
  Write-Host "Found existing aria2 installation at $($existingAriaExe.DirectoryName). Starting it now."
  $ariaPath = $existingAriaExe.FullName
} else {
  Write-Host "Querying GitHub for latest aria2 release..."
  $apiUrl = 'https://api.github.com/repos/aria2/aria2/releases/latest'
  $headers = @{ 'User-Agent' = 'LSDM-installer' }
  $release = Invoke-RestMethod -Uri $apiUrl -Headers $headers

  # Pick a Windows 64-bit asset
  $asset = $release.assets | Where-Object { $_.name -match 'win' -and $_.name -match '64' } | Select-Object -First 1
  if (-Not $asset) {
    Write-Error "Could not find a Windows 64-bit aria2 asset in release. Open https://github.com/aria2/aria2/releases and download manually."
    exit 1
  }

  $downloadUrl = $asset.browser_download_url
  Write-Host "Found asset: $($asset.name)"
  Write-Host "Downloading $downloadUrl to $zipPath ..."

  Invoke-WebRequest -Uri $downloadUrl -OutFile $zipPath -Headers $headers

  Write-Host "Extracting to $ariaDir ..."
  if (Test-Path $ariaDir) { Remove-Item -Recurse -Force $ariaDir }
  Expand-Archive -Path $zipPath -DestinationPath $ariaDir

  # Find aria2c executable
  $ariaExe = Get-ChildItem -Path $ariaDir -Recurse -Filter 'aria2c.exe' | Select-Object -First 1
  if (-Not $ariaExe) {
    Write-Error "aria2c.exe not found after extraction. Please check the extracted contents."
    exit 1
  }
  $ariaPath = $ariaExe.FullName
}

Write-Host "Starting aria2 with RPC enabled..."
Write-Host "aria2 path: $ariaPath"

if (Test-Aria2Alive -Port $RpcPort) {
  Write-Host ""
  Write-Host "An aria2 RPC endpoint is already responding on port $RpcPort - likely LSDM's daemon." -ForegroundColor Yellow
  Write-Host "Skipping second instance to avoid an infinite PORT-already-bound restart loop." -ForegroundColor Yellow
  Write-Host "If you really want to swap daemons, close LSDM first (or 'aria2.shutdown' via RPC), then re-run this script."
  exit 0
}

# Launch through the supervisor script in a new window. Unlike a plain fire-and-forget
# process, this logs all aria2 output to tools\aria2\logs\aria2.log and automatically
# restarts aria2 if it crashes or gets killed (e.g. by antivirus) instead of the window
# just silently closing with no explanation.
$supervisorPath = Join-Path -Path $PSScriptRoot -ChildPath 'run-aria2.ps1'
if (-Not (Test-Path $supervisorPath)) {
  $supervisorPath = Join-Path -Path $toolsDir -ChildPath 'run-aria2.ps1'
}

if (Test-Path $supervisorPath) {
  Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoExit', '-ExecutionPolicy', 'Bypass', '-File', "`"$supervisorPath`"", '-AriaPath', "`"$ariaPath`"")
  Write-Host "aria2 started under the supervisor (separate window)."
  Write-Host "If it keeps closing, that window will now show you why instead of just vanishing -"
  Write-Host "also check: $(Join-Path (Split-Path $ariaPath) 'logs\aria2.log')"
} else {
  Write-Host "Could not find run-aria2.ps1 next to this script - falling back to a plain launch (no crash logging)." -ForegroundColor Yellow
  $rpcArgs = @('--enable-rpc', '--rpc-listen-all=false', '--rpc-allow-origin-all', '--rpc-listen-port=6800', '--max-concurrent-downloads=16', '--split=64', '--max-connection-per-server=16', '--min-split-size=1M', '--optimize-concurrent-downloads=true', '--lowest-speed-limit=0', '--max-overall-download-limit=0', '--max-download-limit=0')
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $ariaPath
  $psi.Arguments = $rpcArgs -join ' '
  $psi.WorkingDirectory = Split-Path $ariaPath
  $psi.UseShellExecute = $true
  [System.Diagnostics.Process]::Start($psi) | Out-Null
}

Write-Host "You can now start the LSDM server (npm start) and open /ariang to monitor downloads."

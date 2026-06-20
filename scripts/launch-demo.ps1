param(
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$nodeExe = 'C:\Program Files\nodejs\node.exe'
$serverPath = Join-Path $RepoRoot 'server.js'
$baseUrl = 'http://127.0.0.1:3000'

function Test-AppReady {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $baseUrl -TimeoutSec 2 | Out-Null
    return $true
  } catch {
    return $false
  }
}

if (-not (Test-AppReady)) {
  Start-Process -FilePath $nodeExe -ArgumentList @($serverPath) -WorkingDirectory $RepoRoot -WindowStyle Hidden | Out-Null
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-AppReady) { break }
  }
}

Start-Process $baseUrl

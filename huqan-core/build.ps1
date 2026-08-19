param(
  [switch]$Release = $true
)

$mingw = "$env:TEMP\w64devkit"
if (!(Test-Path "$mingw\bin\gcc.exe")) {
  Write-Host "MinGW w64devkit not found at $mingw" -ForegroundColor Red
  Write-Host "Download from: https://github.com/skeeto/w64devkit/releases" -ForegroundColor Yellow
  exit 1
}

$oldPath = $env:PATH
$env:PATH = "$mingw\bin;$env:PATH"

$target = "x86_64-pc-windows-gnu"
$mode = if ($Release) { "--release" } else { "" }

Write-Host "Building huqan-core for $target..." -ForegroundColor Cyan
& "$env:USERPROFILE\.cargo\bin\cargo.exe" build $mode --target $target 2>&1
$exitCode = $LASTEXITCODE
$env:PATH = $oldPath

if ($exitCode -eq 0) {
  $bin = if ($Release) { "release" } else { "debug" }
  $exe = "target\$target\$bin\huqan-core.exe"
  Write-Host "Done: $exe" -ForegroundColor Green
}
exit $exitCode

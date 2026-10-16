param(
  [switch]$Release = $true,
  [ValidateSet('gnu', 'msvc')]
  [string]$Toolchain = 'gnu'
)

$mode = if ($Release) { '--release' } else { '' }
$cargo = "$env:USERPROFILE\.cargo\bin\cargo.exe"
$oldPath = $env:PATH
try {
  if ($Toolchain -eq 'gnu') {
    $mingw = "$env:TEMP\w64devkit"
    if (!(Test-Path "$mingw\bin\gcc.exe")) {
      Write-Host "MinGW w64devkit not found at $mingw" -ForegroundColor Red
      Write-Host "Download from: https://github.com/skeeto/w64devkit/releases" -ForegroundColor Yellow
      exit 1
    }
    $env:PATH = "$mingw\bin;$env:PATH"
    $target = 'x86_64-pc-windows-gnu'
  } else {
    $target = 'x86_64-pc-windows-msvc'
  }

  Write-Host "Building huqan-core for $target..." -ForegroundColor Cyan
  & $cargo build $mode --target $target 2>&1
  $exitCode = $LASTEXITCODE
  if ($exitCode -eq 0) {
    $bin = if ($Release) { 'release' } else { 'debug' }
    $exe = "target\$target\$bin\huqan-core.exe"
    Write-Host "Done: $exe" -ForegroundColor Green
  }
  exit $exitCode
} finally {
  $env:PATH = $oldPath
}

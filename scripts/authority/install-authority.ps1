<#
.SYNOPSIS
  Install the HUQAN approval authority as a Windows service (ADR-016, #3860).

.DESCRIPTION
  Run once, elevated, with every agent stopped: enrollment shows the TOTP
  secret on screen, and same-user code can read the screen.

  The service runs as the virtual account NT SERVICE\huqan-authority from a
  directory only administrators can write, using a copy of node.exe whose
  Authenticode signature is checked after it is copied. The code comes from the
  npm tarball of -Version, verified against the registry's dist.integrity, and
  only the files lib/authority/bundle-manifest.js lists are installed. The
  state directory is reachable by SYSTEM and the service SID only. The Start
  menu shortcut that opens the operator window runs elevated from the
  protected install, so its window is out of an agent's reach.

  Paths are fixed, not taken from the environment: the runtime trusts the pin
  at C:\ProgramData\huqan-authority\public\authority.json and nothing else.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File install-authority.ps1 -Version 1.0.2
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
  [string]$NodePath,
  [ValidateRange(1024, 65535)][int]$Port = 47821,
  [switch]$AllowUnsignedNode
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

$ServiceName = 'huqan-authority'
$ServiceAccount = 'NT SERVICE\huqan-authority'
$ProgramDir = 'C:\Program Files\huqan-authority'
$DataDir = 'C:\ProgramData\huqan-authority'
$StateDir = Join-Path $DataDir 'state'
$PublicDir = Join-Path $DataDir 'public'
$LogDir = Join-Path $DataDir 'logs'
$PinFile = Join-Path $PublicDir 'authority.json'
$NodeExe = Join-Path $ProgramDir 'node\node.exe'
$AppDir = Join-Path $ProgramDir 'app'
$ServiceExe = Join-Path $ProgramDir 'huqan-authority.exe'
$Shortcut = 'C:\ProgramData\Microsoft\Windows\Start Menu\Programs\HUQAN Authority.lnk'
$Tar = 'C:\Windows\System32\tar.exe'
$Icacls = 'C:\Windows\System32\icacls.exe'
$Sc = 'C:\Windows\System32\sc.exe'
$WinSwUrl = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'
# SHA-256 of WinSW-x64.exe v2.12.0 (MIT). GitHub publishes no digest for this
# asset; this value was computed on first download (2026-10-12) and is pinned
# so that a changed binary is refused rather than run as SYSTEM.
$WinSwSha256 = '05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA'
$MinNode = [version]'22.13.0'
$Sid = @{ System = '*S-1-5-18'; Admins = '*S-1-5-32-544'; Users = '*S-1-5-32-545' }

function Fail([string]$message) { throw "install-authority: $message" }

function Assert-Elevated {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'run this from an elevated PowerShell' }
}

function Assert-FreshInstall {
  if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) { Fail "service $ServiceName already exists; run uninstall-authority.ps1 first" }
  foreach ($dir in @($ProgramDir, $DataDir)) {
    # A directory the installer did not create may belong to, or link to, anyone.
    if (Test-Path -LiteralPath $dir) { Fail "$dir already exists; remove it (uninstall-authority.ps1) and run again" }
  }
}

function Invoke-Checked([string]$file, [string[]]$arguments) {
  & $file @arguments
  if ($LASTEXITCODE -ne 0) { Fail "$file $($arguments -join ' ') exited $LASTEXITCODE" }
}

function Get-VerifiedPackage([string]$staging) {
  $meta = Invoke-RestMethod -Uri "https://registry.npmjs.org/huqan/$Version" -UseBasicParsing
  $integrity = [string]$meta.dist.integrity
  if (-not $integrity.StartsWith('sha512-')) { Fail "registry metadata for $Version carries no sha512 integrity" }
  $tarball = Join-Path $staging 'huqan.tgz'
  Invoke-WebRequest -Uri ([string]$meta.dist.tarball) -OutFile $tarball -UseBasicParsing
  $hex = (Get-FileHash -LiteralPath $tarball -Algorithm SHA512).Hash
  $bytes = [byte[]]::new($hex.Length / 2)
  for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16) }
  if (('sha512-' + [Convert]::ToBase64String($bytes)) -ne $integrity) { Fail 'the downloaded package does not match the registry integrity' }
  Invoke-Checked $Tar @('-xzf', $tarball, '-C', $staging)
  return (Join-Path $staging 'package')
}

function Install-Node {
  if (-not $NodePath) { $script:NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
  New-Item -ItemType Directory -Path (Split-Path $NodeExe) -Force | Out-Null
  Copy-Item -LiteralPath $NodePath -Destination $NodeExe
  # Checked on the copy, after copying: the source may live in a user-writable
  # directory and change between a check and a copy.
  $signature = Get-AuthenticodeSignature -LiteralPath $NodeExe
  $signed = $signature.Status -eq 'Valid' -and $signature.SignerCertificate.Subject -match 'OpenJS Foundation'
  if (-not $signed -and -not $AllowUnsignedNode) { Fail "$NodePath is not a node.exe signed by the OpenJS Foundation" }
  $nodeVersion = [version](& $NodeExe -p 'process.versions.node')
  if ($nodeVersion -lt $MinNode) { Fail "node $nodeVersion is older than $MinNode" }
}

function Install-Bundle([string]$package) {
  $manifest = Join-Path $package 'lib\authority\bundle-manifest.js'
  $listing = & $NodeExe -e 'process.stdout.write(JSON.stringify(require(process.argv[1]).AUTHORITY_BUNDLE_FILES))' $manifest
  foreach ($relative in ($listing | ConvertFrom-Json)) {
    if ($relative -notmatch '^lib/[A-Za-z0-9_./-]+\.js$' -or $relative -match '\.\.') { Fail "unexpected bundle path $relative" }
    $target = Join-Path $AppDir ($relative -replace '/', '\')
    New-Item -ItemType Directory -Path (Split-Path $target) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $package ($relative -replace '/', '\')) -Destination $target
  }
}

function Install-ServiceHost {
  Invoke-WebRequest -Uri $WinSwUrl -OutFile $ServiceExe -UseBasicParsing
  if ((Get-FileHash -LiteralPath $ServiceExe -Algorithm SHA256).Hash -ne $WinSwSha256) {
    Remove-Item -LiteralPath $ServiceExe -Force
    Fail 'WinSW-x64.exe does not match its pinned SHA-256'
  }
  $serviceMain = Join-Path $AppDir 'lib\authority\service-main.js'
  $xml = @"
<service>
  <id>$ServiceName</id>
  <name>HUQAN Approval Authority</name>
  <description>Holds the HUQAN operator's TOTP secret and signs approval decisions (ADR-016).</description>
  <executable>$NodeExe</executable>
  <arguments>"$serviceMain" serve --state-dir "$StateDir" --port $Port</arguments>
  <env name="NODE_OPTIONS" value="" />
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="10 sec" />
  <logpath>$LogDir</logpath>
  <log mode="roll" />
</service>
"@
  [IO.File]::WriteAllText((Join-Path $ProgramDir 'huqan-authority.xml'), $xml, [Text.Encoding]::ASCII)
  Invoke-Checked $ServiceExe @('install')
  Invoke-Checked $Sc @('config', $ServiceName, 'obj=', $ServiceAccount, 'start=', 'auto')
  Invoke-Checked $Sc @('sidtype', $ServiceName, 'unrestricted')
}

function New-ProtectedTree {
  New-Item -ItemType Directory -Path $DataDir | Out-Null
  Invoke-Checked $Icacls @($DataDir, '/inheritance:r', '/grant:r', "$($Sid.System):(OI)(CI)F", "$($Sid.Admins):(OI)(CI)F", "$($Sid.Users):(OI)(CI)RX")
  Invoke-Checked $Icacls @($DataDir, '/setowner', $Sid.System)
  New-Item -ItemType Directory -Path $PublicDir, $LogDir, $StateDir | Out-Null
  Invoke-Checked $Icacls @($LogDir, '/grant', "${ServiceAccount}:(OI)(CI)M")
  # Administrators keep access to state only until enrollment is proven.
  Invoke-Checked $Icacls @($StateDir, '/inheritance:r', '/grant:r', "$($Sid.System):(OI)(CI)F", "$($Sid.Admins):(OI)(CI)F", "${ServiceAccount}:(OI)(CI)M")
}

function Invoke-Enrollment {
  $serviceMain = Join-Path $AppDir 'lib\authority\service-main.js'
  $init = & $NodeExe $serviceMain init --state-dir $StateDir --public-dir $PublicDir --port $Port | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { Fail 'service-main init failed' }
  $secret = ([uri]$init.otpauthUri).Query -replace '^.*secret=([A-Z2-7]+).*$', '$1'
  Write-Host ''
  Write-Host 'Add this to your authenticator app (setup key, time based, 6 digits, 30 seconds):'
  Write-Host "  Account: HUQAN Authority:operator   Key: $secret"
  Write-Host "  or the URI: $($init.otpauthUri)"
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    $code = Read-Host 'Enter the 6-digit code your app shows now'
    & $NodeExe $serviceMain enroll-check --state-dir $StateDir --code $code | Out-Null
    if ($LASTEXITCODE -eq 0) { Clear-Host; return $init.keyId }
    Write-Host 'That code did not match; wait for the next one and try again.'
  }
  Fail 'enrollment was not confirmed; nothing was started'
}

function Lock-State {
  Invoke-Checked $Icacls @($StateDir, '/remove:g', $Sid.Admins, '/T')
  Invoke-Checked $Icacls @($StateDir, '/setowner', $Sid.System, '/T')
}

function Test-Installed([string]$keyId) {
  Start-Service -Name $ServiceName
  $client = Join-Path $AppDir 'lib\authority\authority-client.js'
  $pin = Join-Path $AppDir 'lib\authority\authority-pin.js'
  $script = 'const fs=require("fs");const p=require(process.argv[2]).parseAuthorityPin(fs.readFileSync(process.argv[3],"utf8"));' +
    'if(!p.ok)process.exit(3);require(process.argv[1]).createAuthorityClient({pin:p.pin}).identity()' +
    '.then(r=>{process.stdout.write(String(r.body&&r.body.keyId));process.exit(r.status===200?0:4)},()=>process.exit(5))'
  for ($wait = 0; $wait -lt 20; $wait++) {
    $answer = & $NodeExe -e $script $client $pin $PinFile
    if ($LASTEXITCODE -eq 0 -and $answer -eq $keyId) { return }
    Start-Sleep -Seconds 1
  }
  Fail "the service did not answer under the pinned key $keyId"
}

function Assert-Protected {
  foreach ($path in @($DataDir, $PublicDir, $StateDir, $PinFile)) {
    $item = Get-Item -LiteralPath $path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail "$path is a link" }
    $acl = Get-Acl -LiteralPath $path
    foreach ($rule in $acl.Access) {
      $who = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
      $writes = $rule.FileSystemRights -band ([Security.AccessControl.FileSystemRights]'Write, Delete, ChangePermissions, TakeOwnership')
      if ($writes -and $who -notin @('S-1-5-18', 'S-1-5-32-544') -and $rule.IdentityReference.Value -ne $ServiceAccount) {
        Fail "$path grants write access to $($rule.IdentityReference)"
      }
    }
  }
}

function New-OperatorShortcut {
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($Shortcut)
  $link.TargetPath = $NodeExe
  $link.Arguments = '"' + (Join-Path $AppDir 'lib\authority\operator-cli.js') + '"'
  $link.WorkingDirectory = $ProgramDir
  $link.Description = 'Decide HUQAN approvals (runs elevated from the protected install)'
  $link.Save()
  # Byte 0x15 bit 0x20 of a .lnk is SLDF_RUNAS_USER: always ask UAC to elevate.
  $bytes = [IO.File]::ReadAllBytes($Shortcut)
  $bytes[0x15] = $bytes[0x15] -bor 0x20
  [IO.File]::WriteAllBytes($Shortcut, $bytes)
}

Assert-Elevated
Assert-FreshInstall
# Windows PowerShell 5.1 does not offer TLS 1.2 by default; npm and GitHub require it.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
New-Item -ItemType Directory -Path $ProgramDir | Out-Null
$staging = Join-Path $ProgramDir 'staging'
New-Item -ItemType Directory -Path $staging | Out-Null
try {
  Install-Node
  Install-Bundle (Get-VerifiedPackage $staging)
} finally {
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
}
# The service must exist before its account can be named in an ACL.
Install-ServiceHost
New-ProtectedTree
$keyId = Invoke-Enrollment
Lock-State
Test-Installed $keyId
Assert-Protected
New-OperatorShortcut
Write-Host "HUQAN approval authority $Version installed (key $keyId, port $Port)."
Write-Host 'Decide approvals from the Start menu: HUQAN Authority. Check the runtime with: huqan-authority status'

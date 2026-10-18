<#
.SYNOPSIS
  Install one shared HUQAN MCP server as a Windows service (ADR-018 section 3, #3999).

.DESCRIPTION
  Run once, elevated. The server runs as its own virtual service account,
  NT SERVICE\huqan-mcp-<name> (no passwords), from a directory only
  administrators can write, using a copy of node.exe whose Authenticode
  signature is checked after it is copied. The code comes from the npm tarball
  of -Version, verified against the registry's dist.integrity.

  Its state directory is reachable by SYSTEM, Administrators, the operator
  account and its own service SID only -- no ACE for the agent user and none
  for another server's account, so one server cannot read another server's
  state. The server's account gets no ACE at all on the protected memory store
  (C:\ProgramData\huqan\state); it reaches the store through the runtime.

  The agent's MCP client configuration points at the loopback endpoint
  (huqan mcp config --name <name>), not at a spawned child. A per-session
  stdio helper stays a child of the agent and reaches the server only as a
  signed-envelope proxy (huqan-mcp proxy).

  Paths are fixed, not taken from the environment. The endpoint pin at
  <data>\public\endpoint.json is what every client-side surface trusts.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File install-mcp-service.ps1 -Name levh -Version 1.0.2 -WorkspaceRoot C:\work\levh
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z][a-z0-9-]{0,31}$')][string]$Name,
  [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
  [Parameter(Mandatory = $true)][ValidateScript({ Test-Path -LiteralPath $_ -PathType Container })][string]$WorkspaceRoot,
  [ValidateRange(1024, 65535)][int]$Port = 47921,
  [string]$OperatorAccount,
  [string]$NodePath,
  [switch]$AllowUnsignedNode
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

$ServiceName = "huqan-mcp-$Name"
$ServiceAccount = "NT SERVICE\$ServiceName"
$ProgramDir = "C:\Program Files\huqan-mcp\$Name"
$DataDir = "C:\ProgramData\huqan\mcp\$Name"
$StateDir = Join-Path $DataDir 'state'
$PublicDir = Join-Path $DataDir 'public'
$LogDir = Join-Path $DataDir 'logs'
$PinFile = Join-Path $PublicDir 'endpoint.json'
$NodeExe = Join-Path $ProgramDir 'node\node.exe'
$AppDir = Join-Path $ProgramDir 'app'
$ServiceExe = Join-Path $ProgramDir "huqan-mcp-$Name.exe"
$Tar = 'C:\Windows\System32\tar.exe'
$Icacls = 'C:\Windows\System32\icacls.exe'
$Sc = 'C:\Windows\System32\sc.exe'
$StoreRoot = 'C:\ProgramData\huqan\state'
$WinSwUrl = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'
# SHA-256 of WinSW-x64.exe v2.12.0 (MIT), pinned exactly as install-authority.ps1
# pins it, so a changed binary is refused rather than run as SYSTEM.
$WinSwSha256 = '05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA'
$MinNode = [version]'22.13.0'
$Sid = @{ System = '*S-1-5-18'; Admins = '*S-1-5-32-544'; Users = '*S-1-5-32-545' }

function Fail([string]$message) { throw "install-mcp-service: $message" }

function Assert-Elevated {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'run this from an elevated PowerShell' }
}

function Assert-FreshInstall {
  if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) { Fail "service $ServiceName already exists; run uninstall-mcp-service.ps1 first" }
  foreach ($dir in @($ProgramDir, $DataDir)) {
    # A directory the installer did not create may belong to, or link to, anyone.
    if (Test-Path -LiteralPath $dir) { Fail "$dir already exists; remove it (uninstall-mcp-service.ps1) and run again" }
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

function Install-App([string]$package) {
  New-Item -ItemType Directory -Path $AppDir | Out-Null
  Copy-Item -Path (Join-Path $package '*') -Destination $AppDir -Recurse -Force
}

function Install-ServiceHost {
  Invoke-WebRequest -Uri $WinSwUrl -OutFile $ServiceExe -UseBasicParsing
  if ((Get-FileHash -LiteralPath $ServiceExe -Algorithm SHA256).Hash -ne $WinSwSha256) {
    Remove-Item -LiteralPath $ServiceExe -Force
    Fail 'WinSW-x64.exe does not match its pinned SHA-256'
  }
  $serviceMain = Join-Path $AppDir 'lib\mcp\service-main.js'
  $xml = @"
<service>
  <id>$ServiceName</id>
  <name>HUQAN MCP $Name</name>
  <description>Shared HUQAN MCP server under its own virtual service account (ADR-018 section 3).</description>
  <executable>$NodeExe</executable>
  <arguments>"$serviceMain" serve --name "$Name" --state-dir "$StateDir" --public-dir "$PublicDir" --port $Port --workspace-root "$WorkspaceRoot" --app-root "$AppDir"</arguments>
  <env name="NODE_OPTIONS" value="" />
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="10 sec" />
  <logpath>$LogDir</logpath>
  <log mode="roll" />
</service>
"@
  [IO.File]::WriteAllText((Join-Path $ProgramDir "$ServiceName.xml"), $xml, [Text.Encoding]::ASCII)
  Invoke-Checked $ServiceExe @('install')
  Invoke-Checked $Sc @('config', $ServiceName, 'obj=', $ServiceAccount, 'start=', 'auto')
  Invoke-Checked $Sc @('sidtype', $ServiceName, 'unrestricted')
}

function New-ProtectedTree {
  New-Item -ItemType Directory -Path $DataDir | Out-Null
  # The data root: SYSTEM and Administrators full, Users read/execute, so the
  # endpoint pin is readable by the surfaces that build client configs.
  Invoke-Checked $Icacls @($DataDir, '/inheritance:r', '/grant:r', "$($Sid.System):(OI)(CI)F", "$($Sid.Admins):(OI)(CI)F", "$($Sid.Users):(OI)(CI)RX")
  Invoke-Checked $Icacls @($DataDir, '/setowner', $Sid.System)
  New-Item -ItemType Directory -Path $PublicDir, $LogDir, $StateDir | Out-Null
  Invoke-Checked $Icacls @($LogDir, '/grant', "${ServiceAccount}:(OI)(CI)M")
  # The state tree: SYSTEM, Administrators, the operator and the server's own
  # service SID only. No ACE for the agent user, none for another server.
  Invoke-Checked $Icacls @($StateDir, '/inheritance:r', '/grant:r',
    "$($Sid.System):(OI)(CI)F", "$($Sid.Admins):(OI)(CI)F", "${OperatorAccount}:(OI)(CI)F", "${ServiceAccount}:(OI)(CI)M")
  Invoke-Checked $Icacls @($StateDir, '/setowner', $Sid.System)
}

function Invoke-Init {
  $serviceMain = Join-Path $AppDir 'lib\mcp\service-main.js'
  $init = & $NodeExe $serviceMain init --name $Name --state-dir $StateDir --public-dir $PublicDir --port $Port --workspace-root $WorkspaceRoot | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { Fail 'service-main init failed' }
  return $init.pin
}

function Test-Installed {
  Start-Service -Name $ServiceName
  # The listener must be up and it must refuse an unsigned request: a server
  # that answers without an envelope is not the boundary this install promises.
  for ($wait = 0; $wait -lt 20; $wait++) {
    # Read the outcome inside the try, decide outside it: a Fail thrown in the
    # try would be swallowed by its own catch. A refused connection (the service
    # is still starting) has no response at all, which strict mode would turn
    # into a terminating error if the status were read unguarded.
    $status = $null
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -Method POST -Body '{}' -ContentType 'application/json' -UseBasicParsing -TimeoutSec 2
      $status = [int]$response.StatusCode
    } catch {
      $failure = $_.Exception
      if ($failure.PSObject.Properties['Response'] -and $null -ne $failure.Response) {
        $status = [int]$failure.Response.StatusCode
      }
    }
    if ($status -eq 403) { return }
    if ($null -ne $status -and $status -lt 400) {
      Fail "the service answered an unsigned request with HTTP $status; the envelope check is not in place"
    }
    Start-Sleep -Seconds 1
  }
  Fail "the service did not reach a fail-closed listener on 127.0.0.1:$Port"
}

# Get-Acl reports account names (NT AUTHORITY\SYSTEM), never the SIDs the
# allow-list is written in: compare SIDs, falling back to the name only for an
# identity that does not translate.
function ConvertTo-SidText([object]$Identity) {
  try {
    if ($Identity -is [Security.Principal.IdentityReference]) { $account = $Identity } else { $account = New-Object Security.Principal.NTAccount([string]$Identity) }
    return $account.Translate([Security.Principal.SecurityIdentifier]).Value
  } catch {
    return [string]$Identity
  }
}

function Assert-Protected {
  foreach ($path in @($DataDir, $PublicDir, $StateDir, $PinFile)) {
    $item = Get-Item -LiteralPath $path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail "$path is a link" }
  }
  $serviceSid = ConvertTo-SidText $ServiceAccount
  $allowed = @('S-1-5-18', 'S-1-5-32-544', (ConvertTo-SidText $OperatorAccount), $serviceSid)
  $stateAcl = Get-Acl -LiteralPath $StateDir
  foreach ($rule in $stateAcl.Access) {
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
    $who = ConvertTo-SidText $rule.IdentityReference
    if ($who -notin $allowed) {
      Fail "$StateDir grants access to $($rule.IdentityReference.Value); only SYSTEM, Administrators, the operator and the service SID may appear"
    }
  }
  # The memory store is the runtime's business: the service SID must hold no
  # ACE at all on it, not even read.
  if (Test-Path -LiteralPath $StoreRoot) {
    $storeAcl = Get-Acl -LiteralPath $StoreRoot
    foreach ($rule in $storeAcl.Access) {
      if ((ConvertTo-SidText $rule.IdentityReference) -eq $serviceSid) {
        Fail "$ServiceAccount holds an ACE on $StoreRoot; MCP servers reach the store through the runtime"
      }
    }
  } else {
    Write-Host "Note: $StoreRoot does not exist yet; run huqan store migrate to create the protected store."
  }
}

Assert-Elevated
Assert-FreshInstall
if (-not $OperatorAccount) {
  $OperatorAccount = [Security.Principal.WindowsIdentity]::GetCurrent().Name
}
# Windows PowerShell 5.1 does not offer TLS 1.2 by default; npm and GitHub require it.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
New-Item -ItemType Directory -Path $ProgramDir | Out-Null
$staging = Join-Path $ProgramDir 'staging'
New-Item -ItemType Directory -Path $staging | Out-Null
try {
  Install-Node
  Install-App (Get-VerifiedPackage $staging)
} finally {
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
}
# The service must exist before its account can be named in an ACL.
Install-ServiceHost
New-ProtectedTree
$pin = Invoke-Init
Test-Installed
Assert-Protected
Write-Host "HUQAN MCP server $Name ($Version) installed as $ServiceName on port $($pin.port), workspace $($pin.workspaceId)."
Write-Host "Client configuration: huqan mcp config --name $Name --client <agent-client> --key-file <seed-file>"
Write-Host "Health and ACL readback: huqan mcp status --name $Name"

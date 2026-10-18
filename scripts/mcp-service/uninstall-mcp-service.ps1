<#
.SYNOPSIS
  Remove one HUQAN MCP server service (ADR-018 section 3, #3999).

.DESCRIPTION
  Stops and removes the service and the protected program directory. The state
  directory -- the enrolled-client registry and the nonce records -- is not
  deleted: it is renamed with its ACL intact, so an audit can still read who
  was enrolled. Removing the endpoint pin is part of the rename, which is why
  this takes an elevated session.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z][a-z0-9-]{0,31}$')][string]$Name
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

$ServiceName = "huqan-mcp-$Name"
$ProgramDir = "C:\Program Files\huqan-mcp\$Name"
$DataDir = "C:\ProgramData\huqan\mcp\$Name"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'uninstall-mcp-service: run this from an elevated PowerShell'
}

if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
  $serviceExe = Join-Path $ProgramDir "$ServiceName.exe"
  if (Test-Path -LiteralPath $serviceExe) { & $serviceExe uninstall } else { & 'C:\Windows\System32\sc.exe' delete $ServiceName }
}
if (Test-Path -LiteralPath $DataDir) {
  $archive = "$DataDir.removed-$(Get-Date -Format 'yyyyMMddHHmmss')"
  Rename-Item -LiteralPath $DataDir -NewName (Split-Path $archive -Leaf)
  Write-Host "State and registry kept at $archive (still readable by SYSTEM and Administrators)."
}
if (Test-Path -LiteralPath $ProgramDir) {
  Remove-Item -LiteralPath $ProgramDir -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "HUQAN MCP server $Name removed; the agent's client configuration must be pointed elsewhere."

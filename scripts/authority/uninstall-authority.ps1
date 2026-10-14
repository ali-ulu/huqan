<#
.SYNOPSIS
  Remove the HUQAN approval authority service (ADR-016, #3860).

.DESCRIPTION
  Stops and removes the service, the protected program directory, the pin and
  the Start menu shortcut. The state directory -- keys, TOTP secret and ledger
  -- is not deleted: it is renamed with its ACL intact, so the ledger stays
  available for an audit. Removing the pin is the only way back to legacy
  mode, which is why it takes an elevated session.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

$ServiceName = 'huqan-authority'
$ProgramDir = 'C:\Program Files\huqan-authority'
$DataDir = 'C:\ProgramData\huqan-authority'
$Shortcut = 'C:\ProgramData\Microsoft\Windows\Start Menu\Programs\HUQAN Authority.lnk'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'uninstall-authority: run this from an elevated PowerShell'
}

if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
  $serviceExe = Join-Path $ProgramDir 'huqan-authority.exe'
  if (Test-Path -LiteralPath $serviceExe) { & $serviceExe uninstall } else { & 'C:\Windows\System32\sc.exe' delete $ServiceName }
}
Remove-Item -LiteralPath $Shortcut -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $DataDir 'public\authority.json') -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $DataDir) {
  $archive = "$DataDir.removed-$(Get-Date -Format 'yyyyMMddHHmmss')"
  Rename-Item -LiteralPath $DataDir -NewName (Split-Path $archive -Leaf)
  Write-Host "State and ledger kept at $archive (still readable by SYSTEM only)."
}
Remove-Item -LiteralPath $ProgramDir -Recurse -Force -ErrorAction SilentlyContinue
Write-Host 'HUQAN approval authority removed; the runtime is back in legacy mode.'

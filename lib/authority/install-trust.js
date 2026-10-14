'use strict';

// Runtime trust check for the installed approval-authority pin (#3860 P5,
// ADR-016 item 9). The default ProgramData ACL lets a standard user create
// subfolders, so before installation a same-user agent can plant its own
// install directory and pin and read back `boundary: os-service` against an
// authority it controls. A reparse-point check does not catch that: a
// planted directory is no link, it is simply owned by the planter.
//
// checkInstallTrust() re-reads the live owner and DACL of the install
// directory, the public directory and the pin file through Get-Acl and
// refuses anything not owned by SYSTEM/Administrators, or anything granting
// write-like rights to a broad identity. Anything it cannot verify fails
// closed. Synchronous: mode resolution is synchronous on every decision
// path, and a check that cannot run is a refusal, not a pass.
//
// Runtime side only: never add this file to the service bundle. It spawns
// powershell.exe, which the bundle forbids (child_process), and the service
// never needs it.

const { spawnSync } = require('node:child_process');

const INSTALL_DIR = 'C:\\ProgramData\\huqan-authority';
const PUBLIC_DIR = 'C:\\ProgramData\\huqan-authority\\public';
const PIN_FILE = 'C:\\ProgramData\\huqan-authority\\public\\authority.json';

const TRUSTED_OWNER_SIDS = Object.freeze(['S-1-5-18', 'S-1-5-32-544']);
const OWNER_NAME_FALLBACK = /system|administrators/i;
// Everyone, Anonymous, Authenticated Users, Users, Guests.
const BROAD_SIDS = Object.freeze(['S-1-1-0', 'S-1-5-7', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-32-546']);
const BROAD_NAME_FALLBACK = /users|everyone|authenticated|guests|anonymous/i;
const WRITE_RIGHTS = /write|delete|modify|fullcontrol|changepermissions|takeownership|create|append/i;

const PROBE =
  "$ErrorActionPreference='Stop'; $out=@(); " +
  `foreach ($p in @('${INSTALL_DIR}','${PUBLIC_DIR}','${PIN_FILE}')) { ` +
  '$a=Get-Acl -LiteralPath $p; ' +
  'try { $o=(New-Object Security.Principal.NTAccount($a.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value } ' +
  'catch { $o=$a.Owner }; $rules=@(); ' +
  'foreach ($r in $a.Access) { ' +
  'try { $s=$r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } ' +
  'catch { $s=$r.IdentityReference.Value }; ' +
  "$rules+=@{'sid'=$s;'rights'=$r.FileSystemRights.ToString();'type'=$r.AccessControlType.ToString()} }; " +
  "$out+=@{'path'=$p;'owner'=$o;'access'=$rules} }; " +
  'ConvertTo-Json $out -Compress -Depth 4';

function grantsWrite(rights) {
  return String(rights).split(/,\s*/).some((name) => {
    const bare = name.trim();
    if (/^Generic(Read|Execute)$/i.test(bare)) return false;
    if (/^Generic(Write|All)$/i.test(bare)) return true;
    return WRITE_RIGHTS.test(bare);
  });
}

function trustedOwner(owner) {
  if (TRUSTED_OWNER_SIDS.includes(owner)) return true;
  return typeof owner === 'string' && !owner.startsWith('S-') && OWNER_NAME_FALLBACK.test(owner);
}

function broadWriter(rule) {
  if (!rule || String(rule.type) !== 'Allow') return false;
  const sid = String(rule.sid || '');
  const broad = BROAD_SIDS.includes(sid) || (!sid.startsWith('S-') && BROAD_NAME_FALLBACK.test(sid));
  return broad && grantsWrite(rule.rights);
}

function probeAcl(spawn) {
  const run = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PROBE],
    { encoding: 'utf8', timeout: 15000 });
  if (!run || run.error || run.status !== 0 || typeof run.stdout !== 'string') return null;
  try {
    const entries = JSON.parse(run.stdout);
    return Array.isArray(entries) ? entries : null;
  } catch (error) {
    return null;
  }
}

function checkInstallTrust({ spawn = spawnSync } = {}) {
  const entries = probeAcl(spawn);
  if (!entries || entries.length !== 3) return { ok: false, reason: 'install_path_untrusted' };
  for (const entry of entries) {
    if (!entry || !trustedOwner(entry.owner)) return { ok: false, reason: 'install_path_untrusted' };
    for (const rule of entry.access || []) {
      if (broadWriter(rule)) return { ok: false, reason: 'install_path_untrusted' };
    }
  }
  return { ok: true };
}

module.exports = { INSTALL_DIR, PUBLIC_DIR, PIN_FILE, checkInstallTrust };

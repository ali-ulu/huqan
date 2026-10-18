'use strict';

// The one definition of the protected store's ACL, and the two operations that
// act on it: apply (the migration command, elevated) and check (the boundary
// report). ADR-018 §3 fixes the shape:
//
//   state\workspaces   SYSTEM and Administrators full, and the runtime service
//                      identity NT SERVICE\huqan-runtime Modify -- the only
//                      additional identity with write access.
//   everywhere else    no ACE for the agent user and none for any MCP server
//                      account; they reach the store through the runtime.
//
// The applier and the verifier share STORE_ACL_SPEC on purpose (#3998 review):
// a check that re-derived "what the ACL should be" from a second list could
// disagree with what was applied and still pass, which is the failure mode the
// check exists to catch. One list, read by both.
//
// Windows-only, like the store itself. On any other platform the boundary
// resolver never reaches the store check (it reports `same-user` with
// `not_windows` first), so these functions are not called there; they still
// answer `not_windows` rather than pretending to have verified something.
//
// Runtime side only: never add this file to the authority service bundle. It
// spawns icacls/powershell, which the bundle forbids (child_process), and the
// service never applies or checks this ACL.

const { spawnSync } = require('node:child_process');

const SYSTEM_SID = 'S-1-5-18';
const ADMINISTRATORS_SID = 'S-1-5-32-544';

// The runtime service identity ADR-018 §3 names. A virtual account: no password,
// the same pattern as NT SERVICE\huqan-authority.
const RUNTIME_SERVICE_ACCOUNT = 'NT SERVICE\\huqan-runtime';

// Everyone, Anonymous, Authenticated Users, Users, Guests: broad identities that
// must never hold write access to the store.
const BROAD_SIDS = Object.freeze(['S-1-1-0', 'S-1-5-7', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-32-546']);
const BROAD_NAME_FALLBACK = /users|everyone|authenticated|guests|anonymous/i;

// The single definition both operations read. Each entry is one ACE the tree
// must carry: the principal (SID for the fixed identities, the service account
// name for the virtual one) and the rights token icacls and the Get-Acl probe
// both spell.
const STORE_ACL_SPEC = Object.freeze({
  // The state root: SYSTEM and Administrators full. The runtime service gets
  // nothing here; its Modify is scoped to the workspaces subtree below.
  stateRoot: Object.freeze([
    Object.freeze({ principal: SYSTEM_SID, rights: 'F' }),
    Object.freeze({ principal: ADMINISTRATORS_SID, rights: 'F' }),
  ]),
  // The workspaces subtree: the two above plus the runtime service's Modify.
  workspaces: Object.freeze([
    Object.freeze({ principal: SYSTEM_SID, rights: 'F' }),
    Object.freeze({ principal: ADMINISTRATORS_SID, rights: 'F' }),
    Object.freeze({ principal: RUNTIME_SERVICE_ACCOUNT, rights: 'M' }),
  ]),
});

// Single-quote only, and refuse anything else: the paths are resolved by the
// product, but the probe is a string that reaches PowerShell, so a path that
// could close its quote is refused rather than escaped.
const SAFE_PATH = /^[A-Za-z]:\\[^'$`\r\n]*$/;

function grantsWrite(rights) {
  return /write|modify|fullcontrol|delete|create|append|changepermissions|takeownership/i.test(String(rights));
}

function isBroadWriter(rule) {
  if (!rule || String(rule.type) !== 'Allow') return false;
  const sid = String(rule.sid || '');
  const broad = BROAD_SIDS.includes(sid) || (!sid.startsWith('S-') && BROAD_NAME_FALLBACK.test(sid));
  return broad && grantsWrite(rule.rights);
}

/**
 * Apply STORE_ACL_SPEC to a freshly created store tree.
 *
 * Windows only. Inheritance is broken first (`/inheritance:r`) so a permissive
 * parent cannot leak a broad write ACE into the store, then each spec entry is
 * granted, then ownership is set to SYSTEM. The two trees get their own spec
 * row: the state root is not given the runtime service's Modify.
 *
 * @returns {{applied: boolean, reason?: string}}
 */
function applyStoreAcl({ stateDir, workspacesDir, spawn = spawnSync, platform = process.platform } = {}) {
  if (platform !== 'win32') return { applied: false, reason: 'not_windows' };
  const targets = [
    { path: stateDir, entries: STORE_ACL_SPEC.stateRoot },
    { path: workspacesDir, entries: STORE_ACL_SPEC.workspaces },
  ];
  for (const target of targets) {
    if (typeof target.path !== 'string' || !SAFE_PATH.test(target.path)) {
      return { applied: false, reason: 'path_untrusted' };
    }
    const args = [target.path, '/inheritance:r', '/grant:r',
      ...target.entries.map((entry) => `${entry.principal}:(OI)(CI)${entry.rights}`)];
    const grant = spawn('icacls.exe', args, { encoding: 'utf8', timeout: 15000 });
    if (!grant || grant.error || grant.status !== 0) return { applied: false, reason: 'acl_apply_failed' };
    const owner = spawn('icacls.exe', [target.path, '/setowner', SYSTEM_SID], { encoding: 'utf8', timeout: 15000 });
    if (!owner || owner.error || owner.status !== 0) return { applied: false, reason: 'acl_apply_failed' };
  }
  return { applied: true };
}

function probeCommand(paths) {
  return "$ErrorActionPreference='Stop'; $out=@(); " +
    `foreach ($p in @(${paths.map(p => `'${p}'`).join(',')})) { ` +
    '$a=Get-Acl -LiteralPath $p; ' +
    'try { $o=(New-Object Security.Principal.NTAccount($a.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value } ' +
    'catch { $o=$a.Owner }; $rules=@(); ' +
    'foreach ($r in $a.Access) { ' +
    'try { $s=$r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } ' +
    'catch { $s=$r.IdentityReference.Value }; ' +
    "$rules+=@{'sid'=$s;'name'=$r.IdentityReference.Value;'rights'=$r.FileSystemRights.ToString();'type'=$r.AccessControlType.ToString()} }; " +
    "$out+=@{'path'=$p;'owner'=$o;'access'=$rules} }; " +
    'ConvertTo-Json $out -Compress -Depth 4';
}

function probeAcl(paths, spawn) {
  const run = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', probeCommand(paths)],
    { encoding: 'utf8', timeout: 15000 });
  if (!run || run.error || run.status !== 0 || typeof run.stdout !== 'string') return null;
  try {
    const entries = JSON.parse(run.stdout);
    return Array.isArray(entries) ? entries : null;
  } catch (_) {
    return null;
  }
}

function holdsEntry(entry, spec) {
  return (entry.access || []).some((rule) => {
    if (String(rule.type) !== 'Allow') return false;
    const names = [String(rule.sid || ''), String(rule.name || '')];
    return names.includes(spec.principal) && grantsWrite(rule.rights);
  });
}

/**
 * Verify a store tree against STORE_ACL_SPEC.
 *
 * Fails closed: a probe that cannot run, a path that cannot be spelled safely,
 * a missing spec entry, or any broad writer all return `{ ok: false }` with a
 * reason. The boundary report turns that into `same-user`, never into `os-user`.
 *
 * @returns {{ok: boolean, reason?: string}}
 */
function checkStoreAcl({ stateDir, workspacesDir, spawn = spawnSync, platform = process.platform } = {}) {
  if (platform !== 'win32') return { ok: false, reason: 'not_windows' };
  const targets = [
    { path: stateDir, entries: STORE_ACL_SPEC.stateRoot },
    { path: workspacesDir, entries: STORE_ACL_SPEC.workspaces },
  ];
  if (targets.some((target) => typeof target.path !== 'string' || !SAFE_PATH.test(target.path))) {
    return { ok: false, reason: 'path_untrusted' };
  }
  const entries = probeAcl(targets.map((target) => target.path), spawn);
  if (!entries || entries.length !== targets.length) return { ok: false, reason: 'acl_unreadable' };
  for (let index = 0; index < targets.length; index += 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== 'object') return { ok: false, reason: 'acl_unreadable' };
    if (![SYSTEM_SID, ADMINISTRATORS_SID].includes(String(entry.owner))
      && !/system|administrators/i.test(String(entry.owner))) {
      return { ok: false, reason: 'acl_untrusted_owner' };
    }
    if ((entry.access || []).some(isBroadWriter)) return { ok: false, reason: 'acl_broad_writer' };
    if (!targets[index].entries.every((spec) => holdsEntry(entry, spec))) {
      return { ok: false, reason: 'acl_missing_grant' };
    }
  }
  return { ok: true };
}

module.exports = {
  ADMINISTRATORS_SID,
  BROAD_SIDS,
  RUNTIME_SERVICE_ACCOUNT,
  STORE_ACL_SPEC,
  SYSTEM_SID,
  applyStoreAcl,
  checkStoreAcl,
  grantsWrite,
  isBroadWriter,
};

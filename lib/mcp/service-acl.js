'use strict';

// The one definition of a protected MCP server's ACL, and the operations that
// act on it (ADR-018 §3, #3999). The Windows installer applies it; the
// operator's `huqan mcp status` reads it back and fails closed.
//
//   state    SYSTEM and Administrators full, the operator full, and the
//            server's own virtual account Modify -- nobody else, no ACE for
//            the agent user, no ACE for another server's account. One server
//            cannot read another server's state.
//   public   SYSTEM and Administrators full, Users read/execute: the endpoint
//            pin must be readable by the surfaces that build client configs.
//   store    the server's account holds no ACE at all on the protected memory
//            store (C:\ProgramData\huqan\state); MCP servers reach it through
//            the runtime, never by opening the file.
//
// The applier and the checker share one spec on purpose, the same way
// lib/authority/store-acl.js does: a check that re-derives "what the ACL
// should be" from a second list could disagree with what was applied and
// still pass, which is the failure mode the check exists to catch.
//
// Windows-only, like the boundary itself. Elsewhere these functions answer
// not_windows rather than pretending to have verified something. Runtime side
// only: the service never applies or checks this ACL, and the authority
// bundle never carries this file (it spawns icacls/powershell).

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const SYSTEM_SID = 'S-1-5-18';
const ADMINISTRATORS_SID = 'S-1-5-32-544';
const USERS_SID = 'S-1-5-32-545';
const DATA_ROOT = 'C:\\ProgramData\\huqan\\mcp';
const STORE_ROOT = 'C:\\ProgramData\\huqan\\state';
const SERVICE_ACCOUNT_PREFIX = 'NT SERVICE\\huqan-mcp-';
const SERVICE_NAME = /^[a-z][a-z0-9-]{0,31}$/;

// The agent user's account name is install-specific, so the check does not
// name it: it refuses ANY principal outside the spec on the state tree, which
// covers the agent user, another server's account and anything an operator
// added by hand.
const BROAD_SIDS = Object.freeze(['S-1-1-0', 'S-1-5-7', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-32-546']);
const BROAD_NAME_FALLBACK = /users|everyone|authenticated|guests|anonymous/i;

// Single-quote only, and refuse anything else: the probe is a string that
// reaches PowerShell, so a path or principal that could close its quote is
// refused rather than escaped.
const SAFE_PATH = /^[A-Za-z]:\\[^'$`\r\n]*$/;
const SAFE_PRINCIPAL = /^[A-Za-z0-9_@\-. \\]{1,128}$/;

function serviceAccountFor(name) {
  if (!SERVICE_NAME.test(String(name || ''))) throw new TypeError('server name must match [a-z][a-z0-9-]{0,31}');
  return `${SERVICE_ACCOUNT_PREFIX}${name}`;
}

function dataDirFor(name) {
  if (!SERVICE_NAME.test(String(name || ''))) throw new TypeError('server name must match [a-z][a-z0-9-]{0,31}');
  return path.win32.join(DATA_ROOT, name);
}

function grantsWrite(rights) {
  return /write|modify|fullcontrol|delete|create|append|changepermissions|takeownership/i.test(String(rights));
}

/** Whether an ACE's actual rights satisfy what the spec entry asks for. */
function rightsSatisfy(actual, wanted) {
  return wanted === 'RX' ? /read/i.test(String(actual)) : grantsWrite(actual);
}

function isBroadWriter(rule) {
  if (!rule || String(rule.type) !== 'Allow') return false;
  const sid = String(rule.sid || '');
  const broad = BROAD_SIDS.includes(sid) || (!sid.startsWith('S-') && BROAD_NAME_FALLBACK.test(sid));
  return broad && grantsWrite(rule.rights);
}

// The single definition both operations read. The operator account is
// install-specific and is handed in; everything else is fixed.
function stateSpec(operatorAccount, serviceAccount) {
  return Object.freeze([
    Object.freeze({ principal: SYSTEM_SID, rights: 'F' }),
    Object.freeze({ principal: ADMINISTRATORS_SID, rights: 'F' }),
    Object.freeze({ principal: operatorAccount, rights: 'F' }),
    Object.freeze({ principal: serviceAccount, rights: 'M' }),
  ]);
}

function publicSpec() {
  return Object.freeze([
    Object.freeze({ principal: SYSTEM_SID, rights: 'F' }),
    Object.freeze({ principal: ADMINISTRATORS_SID, rights: 'F' }),
    Object.freeze({ principal: USERS_SID, rights: 'RX' }),
  ]);
}

function assertSafeInputs({ dataDir, stateDir, operatorAccount, serviceAccount }) {
  for (const value of [dataDir, stateDir]) {
    if (typeof value !== 'string' || !SAFE_PATH.test(value)) return false;
  }
  for (const value of [operatorAccount, serviceAccount]) {
    if (typeof value !== 'string' || !SAFE_PRINCIPAL.test(value)) return false;
  }
  return true;
}

/**
 * Apply the spec to a freshly created server tree (the elevated installer).
 * Inheritance is broken on the data root and on state, so a permissive
 * parent cannot leak a broad ACE into protected state.
 *
 * @returns {{applied: boolean, reason?: string}}
 */
function applyMcpServiceAcl({ dataDir, stateDir, operatorAccount, serviceAccount, spawn = spawnSync, platform = process.platform } = {}) {
  if (platform !== 'win32') return { applied: false, reason: 'not_windows' };
  if (!assertSafeInputs({ dataDir, stateDir, operatorAccount, serviceAccount })) return { applied: false, reason: 'path_untrusted' };
  const grants = [
    { path: dataDir, entries: publicSpec() },
    { path: stateDir, entries: stateSpec(operatorAccount, serviceAccount) },
  ];
  for (const grant of grants) {
    // A `*` before a SID forces icacls to treat it as a SID, never to resolve
    // it as an account name -- the same spoofing guard install-authority.ps1 uses.
    const principalToken = (entry) => `${entry.principal.startsWith('S-1-') ? '*' : ''}${entry.principal}`;
    const args = [grant.path, '/inheritance:r', '/grant:r',
      ...grant.entries.map((entry) => `${principalToken(entry)}:(OI)(CI)${entry.rights}`)];
    const run = spawn('icacls.exe', args, { encoding: 'utf8', timeout: 15000 });
    if (!run || run.error || run.status !== 0) return { applied: false, reason: 'acl_apply_failed' };
    const owner = spawn('icacls.exe', [grant.path, '/setowner', SYSTEM_SID], { encoding: 'utf8', timeout: 15000 });
    if (!owner || owner.error || owner.status !== 0) return { applied: false, reason: 'acl_apply_failed' };
  }
  return { applied: true };
}

function probeCommand(paths) {
  return "$ErrorActionPreference='Stop'; $out=@(); " +
    `foreach ($p in @(${paths.map((p) => `'${p}'`).join(',')})) { ` +
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

function ruleIdentity(rule) {
  return [String(rule.sid || ''), String(rule.name || '')];
}

function holdsEntry(entry, spec) {
  return (entry.access || []).some((rule) => {
    if (String(rule.type) !== 'Allow') return false;
    return ruleIdentity(rule).includes(spec.principal) && rightsSatisfy(rule.rights, spec.rights);
  });
}

function trustedOwner(entry) {
  return [SYSTEM_SID, ADMINISTRATORS_SID].includes(String(entry.owner)) || /system|administrators/i.test(String(entry.owner));
}

/**
 * Verify a server tree against the spec.
 *
 * Fails closed: an unreadable probe, a missing grant, any principal outside
 * the spec (the agent user, another server's account, a hand-added account),
 * or any broad writer all return `{ ok: false }` with a reason.
 *
 * @returns {{ok: boolean, reason?: string}}
 */
function checkMcpServiceAcl({ dataDir, stateDir, operatorAccount, serviceAccount, spawn = spawnSync, platform = process.platform } = {}) {
  if (platform !== 'win32') return { ok: false, reason: 'not_windows' };
  if (!assertSafeInputs({ dataDir, stateDir, operatorAccount, serviceAccount })) return { ok: false, reason: 'path_untrusted' };
  const targets = [
    { path: dataDir, entries: publicSpec(), principals: new Set(publicSpec().map((e) => e.principal)) },
    { path: stateDir, entries: stateSpec(operatorAccount, serviceAccount), principals: new Set(stateSpec(operatorAccount, serviceAccount).map((e) => e.principal)) },
  ];
  const entries = probeAcl(targets.map((target) => target.path), spawn);
  if (!entries || entries.length !== targets.length) return { ok: false, reason: 'acl_unreadable' };
  for (let index = 0; index < targets.length; index += 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== 'object') return { ok: false, reason: 'acl_unreadable' };
    if (!trustedOwner(entry)) return { ok: false, reason: 'acl_untrusted_owner' };
    if ((entry.access || []).some(isBroadWriter)) return { ok: false, reason: 'acl_broad_writer' };
    const rules = entry.access || [];
    if (!targets[index].entries.every((spec) => holdsEntry(entry, spec))) return { ok: false, reason: 'acl_missing_grant' };
    const unexpected = rules.some((rule) => String(rule.type) === 'Allow'
      && !targets[index].principals.has(String(rule.sid || '')) && !targets[index].principals.has(String(rule.name || '')));
    if (unexpected) return { ok: false, reason: 'acl_unexpected_grant' };
  }
  return { ok: true };
}

/**
 * Verify the server's own account holds no ACE at all on the protected
 * memory store. A2A with the store is the runtime's business (ADR-018 §3);
 * a service SID on the store's DACL is the failure this check exists to see.
 *
 * @returns {{ok: boolean, reason?: string}}
 */
function checkNoStoreAce({ storeRoot = STORE_ROOT, serviceAccount, spawn = spawnSync, platform = process.platform } = {}) {
  if (platform !== 'win32') return { ok: false, reason: 'not_windows' };
  if (typeof storeRoot !== 'string' || !SAFE_PATH.test(storeRoot)) return { ok: false, reason: 'path_untrusted' };
  if (typeof serviceAccount !== 'string' || !SAFE_PRINCIPAL.test(serviceAccount)) return { ok: false, reason: 'path_untrusted' };
  const entries = probeAcl([storeRoot], spawn);
  const entry = entries && entries[0];
  if (!entry || typeof entry !== 'object') return { ok: false, reason: 'acl_unreadable' };
  const present = (entry.access || []).some((rule) => ruleIdentity(rule).includes(serviceAccount));
  return present ? { ok: false, reason: 'store_ace_present' } : { ok: true };
}

module.exports = {
  ADMINISTRATORS_SID,
  BROAD_SIDS,
  DATA_ROOT,
  STORE_ROOT,
  SYSTEM_SID,
  USERS_SID,
  applyMcpServiceAcl,
  checkMcpServiceAcl,
  checkNoStoreAce,
  dataDirFor,
  grantsWrite,
  probeCommand,
  rightsSatisfy,
  serviceAccountFor,
  stateSpec,
};

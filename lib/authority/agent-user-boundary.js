'use strict';

// Whether agents run as a separate OS user, in their own session (#3948,
// ADR-017). ADR-016 moved the approval authority behind a service boundary and
// reports `boundary: same-user` in legacy mode so that gap stays visible. It
// left residual risks 1-4 open, all of which reduce to one fact: agents still
// run as the operator. ADR-017 decides they run as a separate local standard
// Windows user. This module reports that decision the same way `same-user` is
// reported today -- a boundary value read live, not a claim in a document.
//
// The marker, not the document, is the evidence. ADR-017 authorises no runtime
// change by itself; the split is only real once the split exists on the
// machine. `install-agent-user.ps1` writes a marker under the protected state
// root when it creates the user, and this module reports `os-user` only when
// that marker is present AND its path still has the ACL the installer set.
//
// That trust step matters for the same reason it does for the authority pin
// (lib/authority/install-trust.js): the default ProgramData ACL lets a standard
// user create a subfolder, so a same-user agent could plant a marker and read
// back the stronger `os-user` against a split that was never made. A planted
// marker is checked against its live owner and DACL and refused if a broad
// identity can write it, exactly like a planted pin. Anything that cannot be
// verified fails closed to `same-user`: the weaker value is the safe one to
// report, because it keeps the gap visible rather than hiding it.
//
// POSIX (linux, darwin) reports the same boundary from the same kind of marker,
// but the evidence is different (ADR-020 section 8). There is no DACL, so trust
// comes from posix-path-trust.js (root-owned, link-free ancestors) and identity
// comes from the marker plus `id`. The marker path is fixed in source and never
// taken from `HUQAN_PROTECTED_STATE_ROOT`: the agent controls its own
// environment, so an env variable must not be able to move the evidence the
// boundary is read from. `os-user` requires the marker to be trusted, the
// marker's agent uid to be non-root and different from the operator's, `id` to
// agree with both, the agent to be outside sudo/wheel/admin, the store to match
// the POSIX spec (store-acl.js), and the migration marker to verify.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkPathTrust } = require('./install-trust');
const { checkPosixPathTrust } = require('./posix-path-trust');
const { checkStoreAcl } = require('./store-acl');
const { verifyMigrationMarker } = require('./store-migrate');
const { protectedStateRoot, workspacesRoot } = require('../protected-store-path');

// Same protected root the ADR names for the memory store (item 3): a directory
// the agent user's token cannot write, ACL'd to the operator and SYSTEM.
const DEFAULT_WINDOWS_STATE_DIR = 'C:\\ProgramData\\huqan\\state';
const DEFAULT_WINDOWS_MARKER_PATH = path.win32.join(DEFAULT_WINDOWS_STATE_DIR, 'agent-boundary.json');

// Not an OS-boundary name by accident: `os-service` is the authority service
// (ADR-016), `env-override` is an authority the environment chose, and
// `same-user` is the legacy fallback. `os-user` names the agent split.
const AGENT_BOUNDARY = 'os-user';
const SAME_USER = 'same-user';

const MARKER_VERSION = 'huqan.agent-boundary.v1';

// Fixed POSIX state roots, constants in source (ADR-020 section 8). These are
// deliberately not `protectedStateRoot()`: that reads HUQAN_PROTECTED_STATE_ROOT,
// and an env variable an agent can set is not evidence of anything.
const POSIX_STATE_ROOT = Object.freeze({
  linux: '/var/lib/huqan/state',
  darwin: '/Library/HUQAN/state',
});
const POSIX_MARKER_FILENAME = 'agent-boundary.json';

// A uid in one of these groups can become root, which voids the os-user split
// (ADR-020 section 9). The names are the conventional ones on the two
// platforms; a group that does not exist simply never matches.
const ADMIN_GROUPS = Object.freeze(['sudo', 'wheel', 'admin']);

/** The fixed POSIX marker path for a platform (under `root` when given), or null. */
function posixMarkerPath(platform, root = posixStateRoot(platform)) {
  return root ? path.posix.join(root, POSIX_MARKER_FILENAME) : null;
}

/**
 * Read and shape-check the marker file. A marker that is absent, unreadable,
 * malformed or of the wrong version is not evidence of a split; the caller
 * decides fail-closed, but the parse itself never throws on the hot path.
 */
function readMarker(markerPath, readFile, { requireUids = false } = {}) {
  let text;
  try {
    text = readFile(markerPath);
  } catch (error) {
    return error && error.code === 'ENOENT' ? { absent: true } : { reason: 'marker_unreadable' };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { reason: 'marker_malformed' };
  }
  // The marker names the user and session split. A v1 marker with no user is
  // not a description of a split and is refused rather than read optimistically.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.v !== MARKER_VERSION
    || typeof parsed.agentUser !== 'string' || !parsed.agentUser.trim()) {
    return { reason: 'marker_malformed' };
  }
  // POSIX reads the identity from the marker's uids, so a marker missing them
  // describes nothing the boundary can corroborate and is malformed there.
  if (requireUids && (!Number.isInteger(parsed.agentUid) || !Number.isInteger(parsed.operatorUid))) {
    return { reason: 'marker_malformed' };
  }
  return { marker: parsed };
}

/** The uid out of a `getent passwd <user>` line, or null if it is not there. */
function parseGetentUid(stdout) {
  const line = String(stdout).split('\n')[0];
  const uid = Number.parseInt(line.split(':')[2], 10);
  return Number.isInteger(uid) ? uid : null;
}

/** The uid out of a `dscl . -read /Users/<user> UniqueID` answer, or null. */
function parseDsclUid(stdout) {
  const match = /UniqueID:\s*(\d+)/.exec(String(stdout));
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Corroborate a marker's user against the system account database: its uid from
 * `getent passwd` (linux) or `dscl` (darwin), and its group names from `id -Gn`.
 *
 * Fail-closed by construction: a probe that cannot run, a non-zero status, junk
 * output or an unparsable uid all answer `agent_uid_mismatch`, and a group probe
 * that cannot run answers the same rather than assuming the agent is out of the
 * admin groups. `agent_uid_mismatch` therefore means "the marker does not match
 * the account database", which is exactly what could not be established.
 *
 * @returns {{uid: number, groups: string[]} | {error: string}}
 */
function resolveAgentIdentity({ agentUser, platform, spawn }) {
  const uidProbe = platform === 'darwin'
    ? spawn('dscl', ['.', '-read', `/Users/${agentUser}`, 'UniqueID'], { encoding: 'utf8', timeout: 5000 })
    : spawn('getent', ['passwd', agentUser], { encoding: 'utf8', timeout: 5000 });
  if (!uidProbe || uidProbe.error || uidProbe.status !== 0 || typeof uidProbe.stdout !== 'string') {
    return { error: 'agent_uid_mismatch' };
  }
  const uid = platform === 'darwin' ? parseDsclUid(uidProbe.stdout) : parseGetentUid(uidProbe.stdout);
  if (!Number.isInteger(uid)) return { error: 'agent_uid_mismatch' };
  const groupsProbe = spawn('id', ['-Gn', agentUser], { encoding: 'utf8', timeout: 5000 });
  if (!groupsProbe || groupsProbe.error || groupsProbe.status !== 0 || typeof groupsProbe.stdout !== 'string') {
    return { error: 'agent_uid_mismatch' };
  }
  const groups = groupsProbe.stdout.trim().split(/\s+/).filter(Boolean);
  return { uid, groups };
}

/** The fixed POSIX state root for a platform, or null where parity does not apply. */
function posixStateRoot(platform) {
  return Object.hasOwn(POSIX_STATE_ROOT, platform) ? POSIX_STATE_ROOT[platform] : null;
}

/**
 * Resolve the agent-user boundary on a POSIX platform (linux, darwin).
 *
 * The order is the ADR-020 section 8 list, and the first failing step names the
 * reason. Every step fails closed to `same-user`.
 */
function resolvePosixBoundary({
  platform, readFile, checkPosixTrust, checkStoreAclImpl, verifyMigrationImpl,
  spawn, workspaceRoot, stateDir, markerPath, stateRoot,
}) {
  const root = stateRoot || posixStateRoot(platform);
  const marker = markerPath || posixMarkerPath(platform, root);
  const read = readMarker(marker, readFile, { requireUids: true });
  if (read.absent) return { value: SAME_USER, reason: 'no_marker' };
  if (!read.marker) return { value: SAME_USER, reason: read.reason };
  // (a) Trust the live ownership and mode of the marker and every ancestor, the
  // POSIX counterpart of the Windows DACL check. A planted marker is refused.
  let trusted = false;
  try {
    trusted = checkPosixTrust([root, marker], { platform }).ok === true;
  } catch (error) {
    trusted = false;
  }
  if (!trusted) return { value: SAME_USER, reason: 'marker_untrusted' };
  // (b) Identity: the marker's uids must be non-root, distinct, and corroborated
  // by the account database, and the agent must be out of the admin groups.
  const { agentUid, operatorUid, agentUser } = read.marker;
  if (agentUid === 0) return { value: SAME_USER, reason: 'agent_uid_is_root' };
  if (agentUid === operatorUid) return { value: SAME_USER, reason: 'agent_is_operator' };
  let identity;
  try {
    identity = resolveAgentIdentity({ agentUser, platform, spawn });
  } catch (error) {
    identity = { error: 'agent_uid_mismatch' };
  }
  if (identity.error) return { value: SAME_USER, reason: identity.error };
  if (identity.uid !== agentUid) return { value: SAME_USER, reason: 'agent_uid_mismatch' };
  if (identity.groups.some((group) => ADMIN_GROUPS.includes(group))) {
    return { value: SAME_USER, reason: 'agent_in_admin_group' };
  }
  // (c) The store must match the POSIX spec: root-owned state root, a 0700
  // workspaces subtree the agent does not own.
  let storeAcl;
  try {
    storeAcl = checkStoreAclImpl({ stateDir: root, workspacesDir: workspacesRoot(root), platform, agentUid });
  } catch (error) {
    storeAcl = { ok: false, reason: 'store_acl_probe_failed' };
  }
  if (storeAcl.ok !== true) {
    return { value: SAME_USER, reason: storeAcl.reason || 'store_acl_unverified' };
  }
  // (d) The migration marker for this workspace must verify.
  let migration;
  try {
    migration = verifyMigrationImpl({ workspaceRoot, stateRoot: root, readFile });
  } catch (error) {
    migration = { ok: false, reason: 'migration_verify_failed' };
  }
  if (migration.ok !== true) {
    return { value: SAME_USER, reason: migration.reason || 'migration_unverified' };
  }
  return { value: AGENT_BOUNDARY, agentUser };
}

/**
 * Resolve the agent-user boundary for this machine.
 *
 * Windows (ADR-018 §1): `os-user` requires all three checks to pass, and the
 * first that fails names the reason.
 *   (a) the agent-user marker is present and trusted (#3982);
 *   (b) the protected store's ACL matches the ADR-018 §3 spec;
 *   (c) the migration marker for the current workspace verifies.
 * A split that satisfies only (a) still reports `same-user`, which is the
 * honest value for an install whose store has not moved yet.
 *
 * POSIX (linux, darwin) reports the same value from the ADR-020 §8 evidence
 * instead; a platform with neither branch is `unsupported_platform`.
 *
 * @returns {{value: string, reason?: string}}
 */
function resolveAgentUserBoundary({
  platform = process.platform,
  readFile = file => fs.readFileSync(file, 'utf8'),
  checkTrust = checkPathTrust,
  checkPosixTrust = checkPosixPathTrust,
  checkStoreAclImpl = checkStoreAcl,
  verifyMigrationImpl = verifyMigrationMarker,
  spawn = spawnSync,
  workspaceRoot = process.cwd(),
  stateDir = DEFAULT_WINDOWS_STATE_DIR,
  markerPath = null,
  stateRoot = null,
} = {}) {
  if (platform !== 'win32') {
    if (!Object.hasOwn(POSIX_STATE_ROOT, platform)) return { value: SAME_USER, reason: 'unsupported_platform' };
    return resolvePosixBoundary({
      platform, readFile, checkPosixTrust, checkStoreAclImpl, verifyMigrationImpl, spawn, workspaceRoot,
      stateDir, markerPath, stateRoot,
    });
  }
  const windowsStateRoot = stateRoot || protectedStateRoot();
  const windowsMarkerPath = markerPath || DEFAULT_WINDOWS_MARKER_PATH;
  const read = readMarker(windowsMarkerPath, readFile);
  if (read.absent) return { value: SAME_USER, reason: 'no_marker' };
  if (!read.marker) return { value: SAME_USER, reason: read.reason };
  // (a) The marker parses, but a planted marker parses too. Trust the live owner
  // and DACL of the state directory and the marker, never the file content alone.
  let trusted = false;
  try {
    trusted = checkTrust([stateDir, windowsMarkerPath]).ok === true;
  } catch (error) {
    trusted = false;
  }
  if (!trusted) return { value: SAME_USER, reason: 'marker_untrusted' };
  // (b) The store's ACL must match §3: SYSTEM and Administrators full, the
  // runtime service Modify on the workspaces subtree, and no broad writer.
  let storeAcl;
  try {
    storeAcl = checkStoreAclImpl({ stateDir, workspacesDir: workspacesRoot(windowsStateRoot) });
  } catch (error) {
    storeAcl = { ok: false, reason: 'store_acl_probe_failed' };
  }
  if (storeAcl.ok !== true) {
    return { value: SAME_USER, reason: storeAcl.reason || 'store_acl_unverified' };
  }
  // (c) The migration marker for this workspace must verify: present,
  // well-formed, and its recorded hashes still matching the copy on disk.
  let migration;
  try {
    migration = verifyMigrationImpl({ workspaceRoot, stateRoot: windowsStateRoot, readFile });
  } catch (error) {
    migration = { ok: false, reason: 'migration_verify_failed' };
  }
  if (migration.ok !== true) {
    return { value: SAME_USER, reason: migration.reason || 'migration_unverified' };
  }
  return { value: AGENT_BOUNDARY, agentUser: read.marker.agentUser };
}

module.exports = {
  AGENT_BOUNDARY,
  ADMIN_GROUPS,
  DEFAULT_WINDOWS_MARKER_PATH,
  DEFAULT_WINDOWS_STATE_DIR,
  POSIX_MARKER_FILENAME,
  POSIX_STATE_ROOT,
  posixMarkerPath,
  MARKER_VERSION,
  SAME_USER,
  resolveAgentUserBoundary,
};

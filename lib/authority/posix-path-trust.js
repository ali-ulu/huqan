'use strict';

// POSIX path trust for the installed approval authority (#4082, ADR-020 §5).
//
// Windows trusts an install by re-reading the live owner and DACL
// (lib/authority/install-trust.js). POSIX has no DACL to read, so the evidence
// has to be assembled from what lstat already reports: the owning uid and the
// permission bits. Before a parsed pin is trusted, every component of the pin's
// path from the file up to `/` must be owned by root, must not be writable by
// group or other, and must not be a symlink. A same-user agent that can write
// any component can plant the whole tree, and a link can point the "installed"
// path at one it planted.
//
// mode bits are not the whole story on macOS: an extended ACL grants access
// without touching them. There is no syscall for it here, so the check runs
// `/bin/ls -lde` and refuses when the listing carries an ACL entry, or when the
// probe cannot run at all. On Linux the POSIX ACL mask is mirrored into the
// group bits, so the group-write test already catches a named-user write entry
// (DERIVED), and no probe is needed.
//
// The authority's own state directory gets a stricter, different rule. It is
// owned by the service user, not root, so ownership is checked against that uid
// and the directory must be closed to group and other entirely. The darwin ACL
// probe applies here too: a mode-0700 directory with an ACL grant is just as
// exposed, and a 0700 mode hides it from the group-bit test.
//
// Runtime side only: never add this file to the service bundle. It spawns
// /bin/ls, which the bundle forbids (child_process), and the service never
// needs it.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Fixed paths, constants in source and never derived from the environment: an
// agent can change its own environment far more cheaply than it can edit code
// (ADR-020 §1). The pin lives under the data root, so walking the pin's
// ancestors covers the pin, `public/` and the data root in one pass.
const POSIX_LAYOUT = Object.freeze({
  linux: Object.freeze({
    installDir: '/opt/huqan-authority',
    dataDir: '/var/lib/huqan-authority',
    serviceUser: 'huqan-authority',
  }),
  darwin: Object.freeze({
    installDir: '/Library/HUQAN/authority',
    dataDir: '/Library/HUQAN/authority-data',
    serviceUser: '_huqanauthority',
  }),
});

const UNTRUSTED = Object.freeze({ ok: false, reason: 'install_path_untrusted' });
const LINKED = Object.freeze({ ok: false, reason: 'install_path_linked' });
const EXPOSED = Object.freeze({ ok: false, reason: 'state_dir_exposed' });

// A darwin `ls -lde` ACL entry: an indented `N: subject rights` line under the
// listing. Pinned against the real format by test/fixtures/darwin-ls-lde-*.txt.
const ACL_ENTRY = /^[ \t]*\d+:[ \t]+\S/m;

/** The fixed layout for a platform, or null where POSIX parity does not apply. */
function posixAuthorityLayout(platform = process.platform) {
  // Own-key check: `POSIX_LAYOUT['__proto__']` and friends would otherwise
  // answer with an inherited value and throw in path.posix.join below.
  const layout = Object.hasOwn(POSIX_LAYOUT, platform) ? POSIX_LAYOUT[platform] : null;
  if (!layout) return null;
  const publicDir = path.posix.join(layout.dataDir, 'public');
  return Object.freeze({
    ...layout,
    publicDir,
    stateDir: path.posix.join(layout.dataDir, 'state'),
    pinPath: path.posix.join(publicDir, 'authority.json'),
  });
}

/** Every path from `target` up to and including the filesystem root. */
function ancestors(target) {
  const out = [];
  let current = path.posix.normalize(target);
  for (;;) {
    out.push(current);
    const parent = path.posix.dirname(current);
    if (parent === current) return out;
    current = parent;
  }
}

/**
 * Does a darwin path carry an extended ACL?
 *
 * Fail-closed by construction: an error, a non-zero status or output that is
 * not a string all answer "yes", so a probe that cannot run refuses the path
 * rather than waving it through.
 */
function hasExtendedAcl(target, { spawn }) {
  const run = spawn('/bin/ls', ['-lde', target], { encoding: 'utf8', timeout: 15000 });
  if (!run || run.error || run.status !== 0 || typeof run.stdout !== 'string') return true;
  return ACL_ENTRY.test(run.stdout);
}

/**
 * Inspect one path component: not a link, root-owned, closed to group and
 * other, and -- on darwin -- free of an extended ACL. A component that is
 * simply absent (ENOENT) is not a finding: nothing is installed there, so
 * there is nothing an agent could have planted.
 */
function inspectComponent(component, { lstat, platform, spawn }) {
  let stat;
  try {
    stat = lstat(component);
  } catch (error) {
    return error && error.code === 'ENOENT' ? { ok: true } : UNTRUSTED;
  }
  if (!stat || typeof stat.isSymbolicLink !== 'function') return UNTRUSTED;
  if (stat.isSymbolicLink()) return LINKED;
  if (stat.uid !== 0) return UNTRUSTED;
  if ((stat.mode & 0o022) !== 0) return UNTRUSTED;
  if (platform === 'darwin' && hasExtendedAcl(component, { spawn })) return UNTRUSTED;
  return { ok: true };
}

/**
 * Trust a set of fixed install paths: each one, and every ancestor up to `/`,
 * must be root-owned, unwritable by group or other, and not a link. Anything
 * that cannot be inspected fails closed.
 *
 * Exported directly, so it gates the platform itself rather than relying on the
 * caller: on a platform without POSIX parity the POSIX rules are the wrong
 * question and every path is refused.
 *
 * @returns {{ok: boolean, reason?: string}} `install_path_linked` when a
 *   component is a symlink, otherwise `install_path_untrusted`.
 */
function checkPosixPathTrust(paths, { lstat = fs.lstatSync, platform = process.platform, spawn = spawnSync } = {}) {
  if (!posixAuthorityLayout(platform)) return UNTRUSTED;
  const list = Array.isArray(paths) ? paths : [paths];
  if (!list.length) return UNTRUSTED;
  const seen = new Set();
  for (const target of list) {
    if (typeof target !== 'string' || !path.posix.isAbsolute(target)) return UNTRUSTED;
    for (const component of ancestors(target)) {
      if (seen.has(component)) continue;
      seen.add(component);
      const verdict = inspectComponent(component, { lstat, platform, spawn });
      if (!verdict.ok) return verdict;
    }
  }
  return { ok: true };
}

/**
 * The trust check `resolveApprovalAuthorityMode` runs against the installed
 * POSIX pin. Same shape as the Windows `checkInstallTrust`: an untrusted path
 * answers `{ok: false}` and the resolver turns that into `required_unavailable`,
 * never into legacy.
 */
function checkPosixInstallTrust({ platform = process.platform, lstat = fs.lstatSync, spawn = spawnSync } = {}) {
  const layout = posixAuthorityLayout(platform);
  if (!layout) return UNTRUSTED;
  return checkPosixPathTrust([layout.pinPath], { platform, lstat, spawn });
}

/**
 * The state directory is owned by the service user, not root, so its rule is
 * different: it must be owned by `serviceUid` and closed to group and other
 * entirely (`mode & 0o077 === 0`). A missing service uid fails closed rather
 * than skipping the ownership test.
 *
 * On darwin the same extended-ACL probe runs here: a 0700 mode hides an ACL
 * grant from the group-bit test, so mode alone is not enough evidence.
 *
 * Like `checkPosixPathTrust`, this is exported directly, so it gates the
 * platform itself: on a platform without POSIX parity the ownership and mode
 * rules do not describe anything, and the check refuses.
 *
 * @returns {{ok: boolean, reason?: string}} `state_dir_exposed` on any deviation.
 */
function checkPosixStateDirTrust(dir, { lstat = fs.lstatSync, serviceUid, platform = process.platform, spawn = spawnSync } = {}) {
  if (!Number.isInteger(serviceUid)) return EXPOSED;
  if (!posixAuthorityLayout(platform)) return EXPOSED;
  let stat;
  try {
    stat = lstat(dir);
  } catch (error) {
    return EXPOSED;
  }
  if (!stat || typeof stat.isSymbolicLink !== 'function') return EXPOSED;
  if (stat.isSymbolicLink()) return EXPOSED;
  if (stat.uid !== serviceUid) return EXPOSED;
  if ((stat.mode & 0o077) !== 0) return EXPOSED;
  if (platform === 'darwin' && hasExtendedAcl(dir, { spawn })) return EXPOSED;
  return { ok: true };
}

module.exports = {
  POSIX_LAYOUT,
  posixAuthorityLayout,
  checkPosixPathTrust,
  checkPosixInstallTrust,
  checkPosixStateDirTrust,
};

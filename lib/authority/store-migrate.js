'use strict';

// `huqan store migrate` and `huqan store migrate --rollback` (ADR-018 §2, #3998).
//
// Moving a workspace's memory into the protected store is the one operation in
// this feature that must never happen on its own. ADR-018 §2 says so twice:
// the command is explicit, and it is elevated. This module is the core the CLI
// wrapper drives; it holds no argv parsing and does no elevation *detection*
// itself -- `isElevated` is injected so a test can decide, and the real check
// lives in `isProcessElevated` below for the CLI to pass in.
//
// The order matters and is the point:
//
//   1. copy the profile store into the protected directory
//   2. verify the copy -- sha256 for both files, and the row/record counts
//   3. write the marker ONLY if verification passed
//
// A marker written before verification, or after a failed one, would switch the
// runtime to a copy that may be truncated. So a failed verification leaves the
// marker absent and the profile store authoritative, which is exactly the state
// before the command ran. That is a test, not a hope (store-migrate.test.js).
//
// The profile original is left in place as the backup: migrate copies, it does
// not move. `--rollback` removes the marker, which is all it takes to send
// resolution back to the profile store; the protected copy stays until the
// operator deletes it, because rollback must not be able to lose data either.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  MARKER_VERSION,
  migrationMarkerPath,
  protectedMemoryDbPath,
  protectedMemoryJsonPath,
  readMigrationMarker,
  workspaceStoreDir,
  workspacesRoot,
} = require('../protected-store-path');
const { applyStoreAcl } = require('./store-acl');

let Database;
try { Database = require('better-sqlite3'); } catch (_) { Database = null; }

function sha256File(filePath, readFile = fs.readFileSync) {
  return crypto.createHash('sha256').update(readFile(filePath)).digest('hex');
}

/**
 * Row counts per table, so the copy is compared record-for-record and not only
 * byte-for-byte. Byte equality already implies this, but a table count survives
 * as human-readable evidence in the marker and catches the case where both
 * files are the same *size* yet the copy stopped mid-write.
 */
function tableRowCounts(dbPath, { open = null } = {}) {
  const openDb = open || ((file) => {
    if (!Database) throw new Error('better-sqlite3 is unavailable; cannot verify table counts');
    return new Database(file, { readonly: true, fileMustExist: true });
  });
  const db = openDb(dbPath);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    const counts = {};
    for (const { name } of tables) {
      counts[name] = db.prepare(`SELECT COUNT(*) AS n FROM "${String(name).replace(/"/g, '""')}"`).get().n;
    }
    return counts;
  } finally {
    try { db.close(); } catch (_) { /* read-only handle; close is best effort */ }
  }
}

function sameCounts(left, right) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, i) => key !== rightKeys[i])) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}

/**
 * Record/key count for the JSON graph. `nodes` is an object, `edges` an array;
 * either alone is a valid store, so an absent section counts as zero rather
 * than a failure.
 */
function jsonRecordCounts(filePath, readFile = fs.readFileSync) {
  const parsed = JSON.parse(readFile(filePath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('invalid graph JSON');
  const nodeCount = parsed.nodes && typeof parsed.nodes === 'object' && !Array.isArray(parsed.nodes)
    ? Object.keys(parsed.nodes).length : 0;
  const edgeCount = Array.isArray(parsed.edges) ? parsed.edges.length : 0;
  return { nodes: nodeCount, edges: edgeCount };
}

function verifyCopy({ sourceDb, targetDb, sourceJson, targetJson, readFile, open }) {
  let sourceDbHash;
  try {
    sourceDbHash = sha256File(sourceDb, readFile);
  } catch (error) {
    return { ok: false, reason: 'source_db_unreadable', detail: error.message };
  }
  let targetDbHash;
  try {
    targetDbHash = sha256File(targetDb, readFile);
  } catch (error) {
    return { ok: false, reason: 'target_db_unreadable', detail: error.message };
  }
  if (sourceDbHash !== targetDbHash) return { ok: false, reason: 'db_hash_mismatch' };

  let sourceCounts;
  let targetCounts;
  try {
    sourceCounts = tableRowCounts(sourceDb, { open });
    targetCounts = tableRowCounts(targetDb, { open });
  } catch (error) {
    return { ok: false, reason: 'db_counts_unreadable', detail: error.message };
  }
  if (!sameCounts(sourceCounts, targetCounts)) return { ok: false, reason: 'db_row_mismatch' };

  const json = { present: Boolean(sourceJson && targetJson) };
  if (json.present) {
    try {
      json.sourceHash = sha256File(sourceJson, readFile);
      json.targetHash = sha256File(targetJson, readFile);
    } catch (error) {
      return { ok: false, reason: 'json_unreadable', detail: error.message };
    }
    if (json.sourceHash !== json.targetHash) return { ok: false, reason: 'json_hash_mismatch' };
    try {
      json.sourceCounts = jsonRecordCounts(sourceJson, readFile);
      json.targetCounts = jsonRecordCounts(targetJson, readFile);
    } catch (error) {
      return { ok: false, reason: 'json_counts_unreadable', detail: error.message };
    }
    if (!sameCounts(json.sourceCounts, json.targetCounts)) return { ok: false, reason: 'json_record_mismatch' };
  }
  return { ok: true, dbSha256: sourceDbHash, dbCounts: sourceCounts, json };
}

/** Whether a path is a regular file (a directory or a dangling link is not). */
function isRegularFile(filePath) {
  try { return fs.statSync(filePath).isFile(); } catch (_) { return false; }
}

/**
 * The real elevation probe. Windows: the process token's integrity level is
 * High (S-1-16-12288) or System. POSIX: euid 0. Anything the probe cannot read
 * counts as not elevated -- the command then refuses, which is the safe end.
 */
function isProcessElevated({ spawn = require('node:child_process').spawnSync, platform = process.platform } = {}) {
  if (platform !== 'win32') {
    return typeof process.geteuid === 'function' && process.geteuid() === 0;
  }
  const run = spawn('whoami.exe', ['/groups'], { encoding: 'utf8', timeout: 10000 });
  if (!run || run.error || run.status !== 0 || typeof run.stdout !== 'string') return false;
  return /S-1-16-(12288|16384)\b/.test(run.stdout);
}

function refuseUnlessElevated(isElevated) {
  if (!isElevated) {
    const error = new Error(
      'huqan store migrate must run from an elevated shell: it writes the protected store '
      + `under the state root. Re-run from an Administrator (Windows) or root (POSIX) prompt.`,
    );
    error.code = 'STORE_MIGRATE_NOT_ELEVATED';
    return error;
  }
  return null;
}

/**
 * Copy the profile store into the protected directory and, only after the copy
 * verifies, write the marker.
 *
 * @returns {{ok: boolean, reason?: string, detail?: string, marker?: object}}
 */
function migrateStore({
  workspaceRoot = process.cwd(),
  sourceDir,
  stateRoot,
  isElevated = false,
  applyAcl = applyStoreAcl,
  copyFile = fs.copyFileSync,
  readFile,
  open,
  now = () => new Date().toISOString(),
} = {}) {
  const refusal = refuseUnlessElevated(isElevated);
  if (refusal) return { ok: false, reason: refusal.code, detail: refusal.message };
  if (typeof sourceDir !== 'string' || !sourceDir.trim()) {
    return { ok: false, reason: 'SOURCE_DIR_REQUIRED', detail: 'the profile store directory must be named' };
  }

  const sourceDb = path.join(sourceDir, 'memory.db');
  const sourceJson = path.join(sourceDir, 'memory.json');
  const targetDir = workspaceStoreDir(workspaceRoot, stateRoot);
  const targetDb = protectedMemoryDbPath(workspaceRoot, stateRoot);
  const targetJson = protectedMemoryJsonPath(workspaceRoot, stateRoot);
  const markerPath = migrationMarkerPath(workspaceRoot, stateRoot);

  if (!isRegularFile(sourceDb)) {
    return { ok: false, reason: 'SOURCE_DB_ABSENT', detail: sourceDb };
  }
  if (path.resolve(sourceDb) === path.resolve(targetDb)) {
    return { ok: false, reason: 'SOURCE_IS_TARGET', detail: sourceDb };
  }

  const jsonPresent = isRegularFile(sourceJson);
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    copyFile(sourceDb, targetDb);
    if (jsonPresent) copyFile(sourceJson, targetJson);
  } catch (error) {
    return { ok: false, reason: 'COPY_FAILED', detail: error.message };
  }

  // A platform with no ACL branch is skipped, as before; a real apply failure
  // is reported. `not_windows` is kept for the platforms the POSIX branch does
  // not cover, where the ACL step has nothing to do.
  const acl = applyAcl({ stateDir: path.resolve(stateRoot), workspacesDir: workspacesRoot(stateRoot) });
  const aclSkipped = ['not_windows', 'unsupported_platform'].includes(acl && acl.reason);
  if (acl && acl.applied === false && acl.reason && !aclSkipped) {
    return { ok: false, reason: 'ACL_APPLY_FAILED', detail: acl.reason };
  }

  const verified = verifyCopy({
    sourceDb,
    targetDb,
    sourceJson: jsonPresent ? sourceJson : null,
    targetJson: jsonPresent ? targetJson : null,
    readFile,
    open,
  });
  if (!verified.ok) return { ok: false, reason: 'VERIFY_FAILED', detail: verified.reason };

  const marker = {
    v: MARKER_VERSION,
    workspaceId: path.basename(targetDir),
    migratedAt: now(),
    sourceDir: path.resolve(sourceDir),
    dbSha256: verified.dbSha256,
    dbTables: verified.dbCounts,
    memoryJson: jsonPresent
      ? { present: true, sha256: verified.json.targetHash, counts: verified.json.targetCounts }
      : { present: false, status: 'absent' },
  };
  try {
    fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    return { ok: false, reason: 'MARKER_WRITE_FAILED', detail: error.message };
  }
  return { ok: true, marker, markerPath, dbPath: targetDb, memoryPath: targetJson };
}

/**
 * Remove the marker, sending resolution back to the profile store. The
 * protected copy is deliberately left on disk: rollback reverses the switch,
 * and deleting the copy here would be the one irreversible step in a command
 * whose whole design is "do not lose data".
 */
function rollbackStore({ workspaceRoot = process.cwd(), stateRoot, isElevated = false, removeFile = fs.rmSync } = {}) {
  const refusal = refuseUnlessElevated(isElevated);
  if (refusal) return { ok: false, reason: refusal.code, detail: refusal.message };
  const markerPath = migrationMarkerPath(workspaceRoot, stateRoot);
  if (!fs.existsSync(markerPath)) return { ok: true, alreadyRolledBack: true, markerPath };
  try {
    removeFile(markerPath, { force: true });
  } catch (error) {
    return { ok: false, reason: 'ROLLBACK_FAILED', detail: error.message };
  }
  return { ok: true, markerPath, protectedCopyKept: workspaceStoreDir(workspaceRoot, stateRoot) };
}

/**
 * Verify the migration marker for a workspace: present, well-formed, and its
 * recorded hashes still match the protected copy on disk. This is check (c) of
 * ADR-018 §1 -- the runtime reports `os-user` only when the marker for the
 * *current* workspace verifies, not merely when some marker exists.
 *
 * A marker whose copy has since been truncated, replaced or removed no longer
 * verifies, so the boundary falls back to `same-user` rather than trusting a
 * pointer to a store that is not there. Absent marker and absent copy are the
 * same answer here: not verified.
 *
 * @returns {{ok: boolean, reason?: string, marker?: object}}
 */
function verifyMigrationMarker({
  workspaceRoot = process.cwd(),
  stateRoot,
  readFile,
} = {}) {
  const read = readMigrationMarker(migrationMarkerPath(workspaceRoot, stateRoot), readFile);
  if (read.absent) return { ok: false, reason: 'no_marker' };
  if (!read.marker) return { ok: false, reason: read.reason };
  const marker = read.marker;
  const dbPath = protectedMemoryDbPath(workspaceRoot, stateRoot);
  if (!isRegularFile(dbPath)) return { ok: false, reason: 'copy_absent' };
  let dbHash;
  try {
    dbHash = sha256File(dbPath, readFile);
  } catch (error) {
    return { ok: false, reason: 'copy_unreadable', detail: error.message };
  }
  if (dbHash !== marker.dbSha256) return { ok: false, reason: 'copy_hash_mismatch' };
  const jsonExpected = marker.memoryJson && marker.memoryJson.present === true;
  const jsonPath = protectedMemoryJsonPath(workspaceRoot, stateRoot);
  if (jsonExpected) {
    if (!isRegularFile(jsonPath)) return { ok: false, reason: 'json_absent' };
    let jsonHash;
    try {
      jsonHash = sha256File(jsonPath, readFile);
    } catch (error) {
      return { ok: false, reason: 'json_unreadable', detail: error.message };
    }
    if (jsonHash !== marker.memoryJson.sha256) return { ok: false, reason: 'json_hash_mismatch' };
  }
  return { ok: true, marker };
}

module.exports = {
  isProcessElevated,
  jsonRecordCounts,
  migrateStore,
  refuseUnlessElevated,
  rollbackStore,
  sha256File,
  tableRowCounts,
  verifyCopy,
  verifyMigrationMarker,
};

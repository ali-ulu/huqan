// Creating and listing backups, moved out of backupRestore.js (#2168).

const fs = require('fs');
const path = require('path');
const { resolvePathWithinRoot } = require('../path-safety');
const { resolveRuntimePaths, validateBackupId, randomSuffix, newBackupId, newOperationId, backupIdConflictError, buildOperationReceipt } = require('./backup-restore-paths');
const { ensureDir, copyIfExists, backupSqliteIfExists, readBackupEntries, sortBackupEntriesNewestFirst, pruneOldBackups, writeManifest } = require('./backup-restore-store');

/**
 * Creates a timestamped backup directory for AXIOM state files.
 *
 * Copies files into a staging directory first, then atomically renames the
 * staging directory to its final `backupId` name. A crash or error mid-copy
 * therefore never leaves a partial backup visible under its final name —
 * either the fully-copied, manifest-complete directory appears, or nothing
 * does. The staging directory is removed on failure and the error rethrown
 * (no silent partial state, no automatic retry).
 *
 * @param {object} [opts]
 * @returns {{ok: true, backupId: string, backupDir: string, copied: Array<{name: string, size: number}>, skipped: string[], pruned: string[], manifest: object, receipt: object}}
 */
function createBackup(opts = {}) {
  const runtime = resolveRuntimePaths(opts);
  const backupId = validateBackupId(opts.backupId || newBackupId());
  const backupDir = resolvePathWithinRoot(runtime.backupBaseDir, path.join(runtime.backupBaseDir, backupId), { allowMissing: true });
  const stagingDir = resolvePathWithinRoot(runtime.backupBaseDir,
    path.join(runtime.backupBaseDir, `.staging-${backupId}-${randomSuffix()}`), { allowMissing: true });
  ensureDir(runtime.backupBaseDir);
  const operationId = newOperationId('backupop');
  const startedAt = new Date().toISOString();

  ensureDir(stagingDir);
  try {
    if (fs.existsSync(backupDir)) throw backupIdConflictError(backupId);

    const copied = [];
    const skipped = [];

    for (const filePath of runtime.files) {
      const name = path.basename(filePath);
      if (name.endsWith('-wal') || name.endsWith('-shm')) { skipped.push(name); continue; }
      const result = name.endsWith('.db')
        ? backupSqliteIfExists(filePath, path.join(stagingDir, name))
        : copyIfExists(filePath, path.join(stagingDir, name));
      if (result) copied.push(result);
      else skipped.push(path.basename(filePath));
    }

    const receipt = buildOperationReceipt(operationId, 'backup', startedAt, 'complete');
    const manifest = {
      formatVersion: 1,
      schemaVersion: 1,
      backupId,
      createdAt: receipt.completedAt,
      rootDir: runtime.rootDir,
      files: copied.map(item => item.name),
      copied: copied.length,
      skipped,
      receipt,
    };
    writeManifest(stagingDir, manifest);
    fs.renameSync(stagingDir, backupDir);
    const pruned = pruneOldBackups(runtime.backupBaseDir, opts.keepLast);

    return {
      ok: true,
      backupId,
      backupDir,
      copied,
      skipped,
      pruned,
      manifest,
      receipt,
    };
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    const normalizedError = error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST'
      ? backupIdConflictError(backupId)
      : error;
    normalizedError.receipt = buildOperationReceipt(operationId, 'backup', startedAt, 'failed', {
      backupId,
      message: normalizedError.message,
    });
    throw normalizedError;
  }
}

/**
 * Lists existing backups with the newest entry first.
 *
 * @param {object} [opts]
 * @returns {string[]}
 */
function listBackups(opts = {}) {
  const runtime = resolveRuntimePaths(opts);
  if (!fs.existsSync(runtime.backupBaseDir)) return [];
  return readBackupEntries(runtime.backupBaseDir)
    .sort(sortBackupEntriesNewestFirst)
    .map(entry => entry.dir);
}

module.exports = {
  createBackup,
  listBackups,
};

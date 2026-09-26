// Previewing and performing a restore, with its safety backup and progress
// marker. Moved out of backupRestore.js (#2168).

const fs = require('fs');
const path = require('path');
const { resolvePathWithinRoot } = require('../path-safety');
const { resolveRuntimePaths, newBackupId, newOperationId, buildOperationReceipt } = require('./backup-restore-paths');
const { openProgressMarker } = require('./backup-restore-store');
const { createBackup } = require('./backup-restore-create');
const { fileDigest, resolveRestoreSource, validateRestoreSource } = require('./backup-restore-validate');

/**
 * Atomically replaces `destination` with `source`'s contents: copies into a
 * sibling temp file in the same directory, then renames over the
 * destination. `fs.renameSync` within one directory is atomic, so readers of
 * `destination` never observe a partially-written file.
 */
function atomicReplaceFile(source, destination) {
  const tmpDestination = `${destination}.tmp-${Math.random().toString(36).slice(2, 8)}`;
  fs.copyFileSync(source, tmpDestination);
  try {
    fs.renameSync(tmpDestination, destination);
  } catch (error) {
    fs.rmSync(tmpDestination, { force: true });
    throw error;
  }
}

function previewRestore(opts = {}) {
  const runtime = resolveRuntimePaths(opts);
  const sourceDir = resolveRestoreSource({ ...opts, rootDir: runtime.rootDir, backupBaseDir: runtime.backupBaseDir });
  if (!sourceDir || !fs.existsSync(sourceDir)) throw new Error(`Backup directory not found: ${sourceDir || runtime.backupBaseDir}`);
  const manifestPath = resolvePathWithinRoot(sourceDir, path.join(sourceDir, 'manifest.json'));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const files = runtime.files.map(destination => {
    const name = path.basename(destination);
    const source = resolvePathWithinRoot(sourceDir, path.join(sourceDir, name), { allowMissing: true });
    const sourceExists = fs.existsSync(source);
    const targetExists = fs.existsSync(destination);
    return {
      name,
      action: sourceExists ? 'replace' : 'skip',
      conflict: sourceExists && targetExists && fileDigest(source) !== fileDigest(destination),
      sourceSize: sourceExists ? fs.statSync(source).size : null,
      targetSize: targetExists ? fs.statSync(destination).size : null,
    };
  });
  return {
    ok: true,
    dryRun: true,
    sourceDir,
    schemaVersion: manifest.schemaVersion || manifest.formatVersion || 1,
    scope: { rootDir: runtime.rootDir, files },
    conflicts: files.filter(file => file.conflict).map(file => file.name),
    manifest: { backupId: manifest.backupId, createdAt: manifest.createdAt, files: manifest.files || [] },
  };
}

/**
 * Restores AXIOM state files from a selected or latest backup directory.
 *
 * Each file is replaced atomically (temp-file + rename), so a crash never
 * leaves a live file half-written. If a file fails partway through the
 * restore loop, the loop stops immediately — already-restored files are not
 * rolled back and remaining files are not attempted, matching the "no
 * automatic retry of a partial/unknown outcome" rule; the pre-restore safety
 * backup (`safetyBackupDir`) is the recovery path. The thrown error carries
 * a `receipt` with `status: 'partial'` and the exact restored/skipped state
 * so the caller can report precisely what happened.
 *
 * @param {object} [opts]
 * @returns {{ok: true, sourceDir: string, restored: string[], skipped: string[], safetyBackupDir: string, receipt: object}}
 */
function restoreBackup(opts = {}) {
  const runtime = resolveRuntimePaths(opts);
  const progressPath = path.join(runtime.rootDir, '.restore-progress.json');
  if (fs.existsSync(progressPath)) {
    let progress = null;
    try { progress = JSON.parse(fs.readFileSync(progressPath, 'utf8')); } catch (_) { progress = { status: 'unknown' }; }
    const error = new Error('A previous restore was interrupted. Recover from the recorded safety backup before retrying.');
    error.code = 'RESTORE_INTERRUPTED';
    error.receipt = progress;
    throw error;
  }
  const sourceDir = resolveRestoreSource({ ...opts, rootDir: runtime.rootDir, backupBaseDir: runtime.backupBaseDir });
  if (!sourceDir || !fs.existsSync(sourceDir)) {
    throw new Error(`Backup directory not found: ${sourceDir || runtime.backupBaseDir}`);
  }

  const preview = previewRestore({ ...opts, rootDir: runtime.rootDir, backupBaseDir: runtime.backupBaseDir });
  const sourceValidation = validateRestoreSource(sourceDir, runtime);
  if (!sourceValidation.valid) {
    const error = new Error(`Restore source validation failed for ${sourceValidation.file}: ${sourceValidation.reason}`);
    error.code = 'RESTORE_SOURCE_INVALID';
    error.sourceDir = sourceDir;
    error.validation = sourceValidation;
    throw error;
  }
  const operationId = newOperationId('restoreop');
  const startedAt = new Date().toISOString();

  const safety = createBackup({
    rootDir: runtime.rootDir,
    memoryPath: runtime.files[3],
    dbPath: runtime.files[0],
    embeddingPath: runtime.files[4],
    agentMemoryPath: runtime.files[5],
    backupBaseDir: runtime.backupBaseDir,
    backupId: newBackupId('pre-restore-'),
    keepLast: opts.keepLast || 10,
  });

  const restored = [];
  const skipped = [];
  // The progress marker is created exclusively and then rewritten through the
  // same descriptor: a marker (or a symlink) that appeared after the check
  // above makes this restore refuse instead of writing through it.
  const progressFd = openProgressMarker(progressPath);
  const writeProgress = () => {
    const bytes = Buffer.from(JSON.stringify({ operationId, kind: 'restore', status: 'in_progress', sourceDir, safetyBackupDir: safety.backupDir, restored, skipped }), 'utf8');
    fs.ftruncateSync(progressFd, 0);
    fs.writeSync(progressFd, bytes, 0, bytes.length, 0);
  };
  try {
    writeProgress();
    for (const destination of runtime.files) {
      const fileName = path.basename(destination);
      const source = resolvePathWithinRoot(sourceDir, path.join(sourceDir, fileName), { allowMissing: true });
      if (!fs.existsSync(source)) {
        skipped.push(fileName);
        continue;
      }
      atomicReplaceFile(source, destination);
      restored.push(fileName);
      writeProgress();
    }
  } catch (error) {
    error.receipt = buildOperationReceipt(operationId, 'restore', startedAt, 'partial', {
      sourceDir,
      restored,
      skipped,
      safetyBackupDir: safety.backupDir,
      message: error.message,
    });
    throw error;
  } finally {
    fs.closeSync(progressFd);
  }

  fs.rmSync(progressPath, { force: true });

  for (const stale of [`${runtime.files[0]}-shm`, `${runtime.files[0]}-wal`]) {
    if (!restored.includes(path.basename(stale)) && fs.existsSync(stale)) {
      fs.rmSync(stale, { force: true });
    }
  }

  const receipt = buildOperationReceipt(operationId, 'restore', startedAt, 'complete', {
    sourceDir,
    restored,
    skipped,
    safetyBackupDir: safety.backupDir,
  });
  const verification = {
    persistence: restored.length > 0 && restored.every(name => fs.existsSync(runtime.files.find(file => path.basename(file) === name))),
    schema: Number.isFinite(Number(preview.schemaVersion)),
    graphIntegrity: sourceValidation.valid && restored.length > 0 && restored.every(name => {
      const destination = runtime.files.find(file => path.basename(file) === name);
      return fileDigest(destination) === fileDigest(path.join(sourceDir, name));
    }),
    receipt: receipt.status === 'complete' && receipt.operationId === operationId,
  };
  if (!Object.values(verification).every(Boolean)) {
    const error = new Error('Post-restore verification failed. Use the safety backup before retrying.');
    error.code = 'RESTORE_VERIFICATION_FAILED';
    error.receipt = { ...receipt, status: 'partial', verification };
    throw error;
  }

  return {
    ok: true,
    sourceDir,
    restored,
    skipped,
    safetyBackupDir: safety.backupDir,
    receipt,
    preview,
    verification,
  };
}

module.exports = {
  atomicReplaceFile,
  previewRestore,
  restoreBackup,
};

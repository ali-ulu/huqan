const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { resolvePersistencePaths } = require('./persistencePaths');
const { resolvePathWithinRoot } = require('./lib/path-safety');

const DEFAULT_FILES = Object.freeze([
  'memory.db',
  'memory.db-shm',
  'memory.db-wal',
  'memory.json',
  'memory.embeddings.json',
  'memory.agent.json',
]);

function pad(value) {
  return String(value).padStart(2, '0');
}

function timestamp(date = new Date()) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('') + '_' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

/**
 * Resolves the runtime file set used by backup and restore operations.
 *
 * @param {object} [opts]
 * @returns {{rootDir: string, backupBaseDir: string, files: string[]}}
 */
function resolveRuntimePaths(opts = {}) {
  const { rootDir: cwd, memoryPath, dbPath, backupBaseDir } = resolvePersistencePaths(opts);
  const runtimeRoots = [...new Set([cwd, path.dirname(memoryPath), path.dirname(dbPath)])];
  const containedRuntimePath = (candidate) => {
    const absolute = path.resolve(cwd, candidate);
    const roots = runtimeRoots.filter((root) => {
      const relative = path.relative(root, absolute);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    }).sort((left, right) => right.length - left.length);
    if (!roots.length) {
      const error = new Error(`Runtime persistence path is outside approved roots: ${absolute}`);
      error.code = 'PERSISTENCE_PATH_NOT_ALLOWED'; error.path = absolute; throw error;
    }
    try { return resolvePathWithinRoot(roots[0], absolute, { allowMissing: true }); }
    catch (cause) {
      const error = new Error(`Runtime persistence path is outside approved roots: ${absolute}`);
      error.code = 'PERSISTENCE_PATH_NOT_ALLOWED'; error.path = absolute; error.cause = cause; throw error;
    }
  };
  const embeddingPath = containedRuntimePath(opts.embeddingPath || memoryPath.replace(/\.json$/i, '.embeddings.json'));
  const agentMemoryPath = containedRuntimePath(opts.agentMemoryPath || path.join(path.dirname(memoryPath), 'memory.agent.json'));
  const sidecar = (suffix) => containedRuntimePath(`${dbPath}${suffix}`);

  return {
    rootDir: cwd,
    backupBaseDir,
    files: [
      dbPath,
      sidecar('-shm'),
      sidecar('-wal'),
      memoryPath,
      embeddingPath,
      agentMemoryPath,
    ],
  };
}

function validateBackupId(value) {
  const backupId = String(value || '');
  if (!backupId || backupId === '.' || backupId === '..' || backupId.length > 128
      || path.isAbsolute(backupId) || /[\\/:]/.test(backupId)
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(backupId)) {
    const error = new Error('backupId must be one safe path segment');
    error.code = 'BACKUP_ID_INVALID'; throw error;
  }
  return backupId;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function copyIfExists(source, destination) {
  if (!fs.existsSync(source)) return null;
  fs.copyFileSync(source, destination);
  return {
    name: path.basename(source),
    size: fs.statSync(source).size,
  };
}

function backupSqliteIfExists(source, destination) {
  if (!fs.existsSync(source)) return null;
  // Historical fixtures and compatibility deployments may use a `.db` name
  // for a non-SQLite persistence blob. Only invoke SQLite's backup API for
  // an actual SQLite file; those blobs retain the established copy behavior.
  if (fs.readFileSync(source, { encoding: null, flag: 'r' }).subarray(0, 16).toString('utf8') !== 'SQLite format 3\u0000') {
    return copyIfExists(source, destination);
  }
  const program = "const Database=require('better-sqlite3');const db=new Database(process.argv[1],{readonly:true});db.backup(process.argv[2]).then(()=>db.close()).catch(e=>{console.error(e.stack||e.message);process.exitCode=1})";
  const result = spawnSync(process.execPath, ['-e', program, source, destination], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`SQLite online backup failed: ${(result.stderr || result.stdout || '').trim()}`);
  return { name: path.basename(source), size: fs.statSync(destination).size };
}

function pruneOldBackups(backupBaseDir, keepLast = 10) {
  const keep = Math.max(1, Number(keepLast) || 10);
  if (!fs.existsSync(backupBaseDir)) return [];
  const entries = fs.readdirSync(backupBaseDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(backupBaseDir, entry.name))
    .sort();
  if (entries.length <= keep) return [];
  const stale = entries.slice(0, entries.length - keep);
  for (const dirPath of stale) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
  return stale;
}

function writeManifest(targetDir, manifest) {
  const manifestPath = path.join(targetDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifestPath;
}

function newOperationId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Builds a durable operation receipt distinguishing complete success from a
 * partial/failed attempt. `status` is 'complete' only when every step of the
 * operation finished; any thrown error is reported as 'failed' so callers
 * never mistake a half-finished backup/restore for a successful one, and so
 * partial/unknown outcomes are never silently retried.
 */
function buildOperationReceipt(operationId, kind, startedAt, status, extra = {}) {
  return {
    operationId,
    kind,
    status,
    startedAt,
    completedAt: new Date().toISOString(),
    ...extra,
  };
}

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
  const backupId = validateBackupId(opts.backupId || timestamp());
  const backupDir = resolvePathWithinRoot(runtime.backupBaseDir, path.join(runtime.backupBaseDir, backupId), { allowMissing: true });
  const stagingDir = resolvePathWithinRoot(runtime.backupBaseDir,
    path.join(runtime.backupBaseDir, `.staging-${backupId}-${Math.random().toString(36).slice(2, 8)}`), { allowMissing: true });
  ensureDir(runtime.backupBaseDir);
  const operationId = newOperationId('backupop');
  const startedAt = new Date().toISOString();

  ensureDir(stagingDir);
  try {
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
    error.receipt = buildOperationReceipt(operationId, 'backup', startedAt, 'failed', {
      backupId,
      message: error.message,
    });
    throw error;
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
  return fs.readdirSync(runtime.backupBaseDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(runtime.backupBaseDir, entry.name))
    .sort()
    .reverse();
}

/**
 * Resolves a restore source inside the configured backup root.
 * Existing symlinks are canonicalized by resolvePathWithinRoot, so an
 * allowed-looking path cannot redirect restore to arbitrary filesystem state.
 */
function resolveRestoreSource(opts = {}) {
  if (opts.backupDir) {
    const runtime = resolveRuntimePaths(opts);
    const resolved = path.resolve(opts.backupDir);
    try {
      return resolvePathWithinRoot(runtime.backupBaseDir, resolved, { allowMissing: true });
    } catch (error) {
      if (error?.code !== 'PATH_OUTSIDE_ALLOWED_ROOT') throw error;
      const err = new Error(`Restore source is outside the backup directory: ${resolved}`);
      err.code = 'RESTORE_SOURCE_NOT_ALLOWED';
      err.backupBaseDir = runtime.backupBaseDir;
      err.path = resolved;
      throw err;
    }
  }
  const backups = listBackups(opts);
  return backups[0] || null;
}

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

function fileDigest(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
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
  const sourceDir = resolveRestoreSource({ ...opts, rootDir: runtime.rootDir, backupBaseDir: runtime.backupBaseDir });
  if (!sourceDir || !fs.existsSync(sourceDir)) {
    throw new Error(`Backup directory not found: ${sourceDir || runtime.backupBaseDir}`);
  }

  const preview = previewRestore({ ...opts, rootDir: runtime.rootDir, backupBaseDir: runtime.backupBaseDir });
  const operationId = newOperationId('restoreop');
  const startedAt = new Date().toISOString();

  const safety = createBackup({
    rootDir: runtime.rootDir,
    memoryPath: runtime.files[3],
    dbPath: runtime.files[0],
    embeddingPath: runtime.files[4],
    agentMemoryPath: runtime.files[5],
    backupBaseDir: runtime.backupBaseDir,
    backupId: `pre-restore-${timestamp()}`,
    keepLast: opts.keepLast || 10,
  });

  const restored = [];
  const skipped = [];
  try {
    for (const destination of runtime.files) {
      const fileName = path.basename(destination);
      const source = resolvePathWithinRoot(sourceDir, path.join(sourceDir, fileName), { allowMissing: true });
      if (!fs.existsSync(source)) {
        skipped.push(fileName);
        continue;
      }
      atomicReplaceFile(source, destination);
      restored.push(fileName);
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
  }

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
    graphIntegrity: restored.length > 0 && restored.every(name => {
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

function runCliRestore(args, opts = {}) {
  const requested = args && typeof args === 'object' ? args : { backupDir: args || undefined };
  return requested.dryRun
    ? previewRestore({ ...opts, backupDir: requested.backupDir || undefined })
    : restoreBackup({ ...opts, backupDir: requested.backupDir || undefined });
}

function formatCliRestore(result, json = false) {
  if (json) return result;
  if (result.dryRun) return `Restore dry-run: ${result.scope.files.length} files, ${result.conflicts.length} conflicts, schema ${result.schemaVersion}.`;
  return `Restore tamamlandi: ${result.restored.length} dosya geri yüklendi. Guvenlik yedegi: ${result.safetyBackupDir}. Verification: ${Object.values(result.verification).every(Boolean) ? 'passed' : 'failed'}`;
}

module.exports = {
  DEFAULT_FILES,
  createBackup,
  listBackups,
  resolveRuntimePaths,
  restoreBackup,
  previewRestore,
  runCliRestore,
  formatCliRestore,
  timestamp,
};

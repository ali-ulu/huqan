// Backup ids, operation ids, runtime path resolution and the operation
// receipt shape, moved out of backupRestore.js (#2168).

const path = require('path');
const { resolvePersistencePaths } = require('../../persistencePaths');
const { resolvePathWithinRoot } = require('../path-safety');
const { derivePersistenceLayout } = require('../memory-store-utils');

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
 * @returns {{rootDir: string, backupBaseDir: string, files: string[], journalPath: string}}
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
  // JSON-backend mutation journal (receipt chain + operation replay
  // authority). Derived from the same layout API the JSON backend writes
  // with (graph.js jsonJournalPath -> derivePersistenceLayout), so the
  // backup file set cannot drift from the runtime layout; in SQLite mode
  // the journal lives in the database and this file is normally absent.
  // Appended last: restoreBackup addresses files[0]/[3]/[4]/[5] positionally.
  const journalPath = containedRuntimePath(derivePersistenceLayout(memoryPath, dbPath).journalPath);

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
      journalPath,
    ],
    journalPath,
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

function randomSuffix() {
  return Math.random().toString(36).slice(2, 10);
}

function newBackupId(prefix = '') {
  return `${prefix}${timestamp()}-${randomSuffix()}`;
}

function newOperationId(prefix) {
  return `${prefix}_${Date.now()}_${randomSuffix()}`;
}

function backupIdConflictError(backupId) {
  const error = new Error(`A backup already exists with this id: ${backupId}`);
  error.code = 'BACKUP_ID_CONFLICT';
  error.backupId = backupId;
  return error;
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

module.exports = {
  DEFAULT_FILES,
  pad,
  timestamp,
  resolveRuntimePaths,
  validateBackupId,
  randomSuffix,
  newBackupId,
  newOperationId,
  backupIdConflictError,
  buildOperationReceipt,
};

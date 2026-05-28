const fs = require('fs');
const path = require('path');
const { resolvePersistencePaths } = require('./persistencePaths');

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
  const embeddingPath = path.resolve(cwd, opts.embeddingPath || memoryPath.replace(/\.json$/i, '.embeddings.json'));
  const agentMemoryPath = path.resolve(cwd, opts.agentMemoryPath || path.join(path.dirname(memoryPath), 'memory.agent.json'));

  return {
    rootDir: cwd,
    backupBaseDir,
    files: [
      dbPath,
      `${dbPath}-shm`,
      `${dbPath}-wal`,
      memoryPath,
      embeddingPath,
      agentMemoryPath,
    ],
  };
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

/**
 * Creates a timestamped backup directory for AXIOM state files.
 *
 * @param {object} [opts]
 * @returns {{ok: true, backupId: string, backupDir: string, copied: Array<{name: string, size: number}>, skipped: string[], pruned: string[], manifest: object}}
 */
function createBackup(opts = {}) {
  const runtime = resolveRuntimePaths(opts);
  ensureDir(runtime.backupBaseDir);
  const backupId = opts.backupId || timestamp();
  const backupDir = ensureDir(path.join(runtime.backupBaseDir, backupId));
  const copied = [];
  const skipped = [];

  for (const filePath of runtime.files) {
    const result = copyIfExists(filePath, path.join(backupDir, path.basename(filePath)));
    if (result) copied.push(result);
    else skipped.push(path.basename(filePath));
  }

  const manifest = {
    backupId,
    createdAt: new Date().toISOString(),
    rootDir: runtime.rootDir,
    files: copied.map(item => item.name),
    copied: copied.length,
    skipped,
  };
  writeManifest(backupDir, manifest);
  const pruned = pruneOldBackups(runtime.backupBaseDir, opts.keepLast);

  return {
    ok: true,
    backupId,
    backupDir,
    copied,
    skipped,
    pruned,
    manifest,
  };
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

function resolveRestoreSource(opts = {}) {
  if (opts.backupDir) return path.resolve(opts.backupDir);
  const backups = listBackups(opts);
  return backups[0] || null;
}

/**
 * Restores AXIOM state files from a selected or latest backup directory.
 *
 * @param {object} [opts]
 * @returns {{ok: true, sourceDir: string, restored: string[], skipped: string[], safetyBackupDir: string}}
 */
function restoreBackup(opts = {}) {
  const runtime = resolveRuntimePaths(opts);
  const sourceDir = resolveRestoreSource({ ...opts, rootDir: runtime.rootDir, backupBaseDir: runtime.backupBaseDir });
  if (!sourceDir || !fs.existsSync(sourceDir)) {
    throw new Error(`Backup directory not found: ${sourceDir || runtime.backupBaseDir}`);
  }

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
  for (const destination of runtime.files) {
    const fileName = path.basename(destination);
    const source = path.join(sourceDir, fileName);
    if (!fs.existsSync(source)) {
      skipped.push(fileName);
      continue;
    }
    fs.copyFileSync(source, destination);
    restored.push(fileName);
  }

  for (const stale of [`${runtime.files[0]}-shm`, `${runtime.files[0]}-wal`]) {
    if (!restored.includes(path.basename(stale)) && fs.existsSync(stale)) {
      fs.rmSync(stale, { force: true });
    }
  }

  return {
    ok: true,
    sourceDir,
    restored,
    skipped,
    safetyBackupDir: safety.backupDir,
  };
}

module.exports = {
  DEFAULT_FILES,
  createBackup,
  listBackups,
  resolveRuntimePaths,
  restoreBackup,
  timestamp,
};

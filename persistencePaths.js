const fs = require('fs');
const path = require('path');

function pathEscapeError(label) {
  const err = new Error(`Persistence path escapes workspace: ${label}`);
  err.code = 'AXIOM_PATH_OUTSIDE_WORKSPACE';
  return err;
}

function resolveInsideWorkspace(rootDir, candidate, label) {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw pathEscapeError(label);
  }
  if (candidate.includes('\u0000')) {
    throw pathEscapeError(label);
  }
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  if (relative === '') return resolved;
  if (path.isAbsolute(relative) || relative.startsWith('..') || relative === '..') {
    throw pathEscapeError(label);
  }
  return resolved;
}

function resolvePersistencePaths(opts = {}) {
  const workspaceRoot = path.resolve(opts.workspaceRoot || opts.rootDir || process.cwd());
  const cwd = path.resolve(opts.rootDir || workspaceRoot);
  const memoryInput = opts.memoryPath || process.env.AXIOM_MEMORY_PATH || 'memory.json';
  const memoryPath = resolveInsideWorkspace(workspaceRoot, memoryInput, 'memoryPath');
  const dbInput = opts.dbPath || process.env.AXIOM_DB_PATH || memoryInput.replace(/\.json$/i, '.db');
  const dbPath = resolveInsideWorkspace(workspaceRoot, dbInput, 'dbPath');
  const backupInput = opts.backupBaseDir || process.env.AXIOM_BACKUP_DIR || path.join(path.dirname(memoryInput), 'backups');
  const backupBaseDir = resolveInsideWorkspace(workspaceRoot, backupInput, 'backupBaseDir');

  return {
    rootDir: cwd,
    workspaceRoot,
    memoryPath,
    dbPath,
    backupBaseDir,
  };
}

function canWriteTo(targetPath, kind = 'file') {
  try {
    const probePath = kind === 'dir'
      ? path.join(targetPath, `.axiom-write-${process.pid}-${Date.now()}.tmp`)
      : `${targetPath}.axiom-write-${process.pid}-${Date.now()}.tmp`;
    const parentDir = kind === 'dir' ? targetPath : path.dirname(targetPath);
    fs.mkdirSync(parentDir, { recursive: true });
    fs.writeFileSync(probePath, 'ok');
    fs.rmSync(probePath, { force: true });
    return true;
  } catch (_) {
    return false;
  }
}

function inspectPersistence(opts = {}) {
  const paths = resolvePersistencePaths(opts);
  return {
    memoryPath: paths.memoryPath,
    memoryExists: fs.existsSync(paths.memoryPath),
    memoryWritable: canWriteTo(paths.memoryPath, 'file'),
    dbPath: paths.dbPath,
    dbExists: fs.existsSync(paths.dbPath),
    dbWritable: canWriteTo(paths.dbPath, 'file'),
    backupBaseDir: paths.backupBaseDir,
    backupDirExists: fs.existsSync(paths.backupBaseDir),
    backupDirWritable: canWriteTo(paths.backupBaseDir, 'dir'),
  };
}

module.exports = {
  canWriteTo,
  inspectPersistence,
  pathEscapeError,
  resolveInsideWorkspace,
  resolvePersistencePaths,
};

const fs = require('fs');
const path = require('path');

function resolvePersistencePaths(opts = {}) {
  const cwd = path.resolve(opts.rootDir || process.cwd());
  const memoryPath = path.resolve(cwd, opts.memoryPath || process.env.AXIOM_MEMORY_PATH || 'memory.json');
  const dbPath = path.resolve(cwd, opts.dbPath || process.env.AXIOM_DB_PATH || memoryPath.replace(/\.json$/i, '.db'));
  const backupBaseDir = path.resolve(cwd, opts.backupBaseDir || process.env.AXIOM_BACKUP_DIR || path.join(path.dirname(memoryPath), 'backups'));

  return {
    rootDir: cwd,
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
  resolvePersistencePaths,
};

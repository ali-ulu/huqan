const fs = require('fs');
const path = require('path');
const os = require('os');
const { resolveContainedPath, siblingPersistencePath } = require('./lib/memory-store-utils');
const { readCompatibleEnvironmentVariable } = require('./lib/environment-compat');
const { probeWritablePathSync } = require('./lib/secure-file-write');
const { protectedMemoryPathIfSelected } = require('./lib/protected-store-path');

function resolvePersistencePaths(opts = {}) {
  const cwd = path.resolve(opts.rootDir || process.cwd());
  const allowedRoots = [cwd, os.tmpdir()];
  // ADR-018 §2: when the protected store is selected for this workspace it
  // replaces the *derived* default, so nothing falls back to the working
  // directory. An explicit `opts.memoryPath` is a choice, not a fallback, and
  // still wins -- the criterion is about derivation, not about overriding a
  // caller who named a path. Its directory joins the allowed roots so
  // resolveContainedPath admits the path that is deliberately outside cwd.
  const namedMemory = opts.memoryPath || readCompatibleEnvironmentVariable('MEMORY_PATH');
  const protectedSelection = (opts.protected === false || namedMemory)
    ? null
    : protectedMemoryPathIfSelected({ workspaceRoot: cwd });
  if (protectedSelection) allowedRoots.push(path.dirname(protectedSelection.memoryPath));
  const memoryPath = resolveContainedPath(
    protectedSelection ? protectedSelection.memoryPath : path.resolve(cwd, namedMemory || 'memory.json'),
    allowedRoots,
  );
  const dbPath = resolveContainedPath(
    protectedSelection
      ? protectedSelection.dbPath
      : path.resolve(cwd, opts.dbPath || readCompatibleEnvironmentVariable('DB_PATH') || siblingPersistencePath(memoryPath, '.db')),
    [...allowedRoots, path.dirname(memoryPath)],
  );
  const backupBaseDir = resolveContainedPath(
    path.resolve(cwd, opts.backupBaseDir || readCompatibleEnvironmentVariable('BACKUP_DIR') || path.join(path.dirname(memoryPath), 'backups')),
    [...allowedRoots, path.dirname(memoryPath)],
  );

  return {
    rootDir: cwd,
    memoryPath,
    dbPath,
    backupBaseDir,
  };
}

/**
 * The user-data root for artefacts that must survive a read-only install
 * (receipt exports, gate telemetry). Same convention as the external-action
 * gate's own state root in lib/external-action-receipt.js: HUQAN_STATE_ROOT
 * wins when set, otherwise the platform state dir (`%LOCALAPPDATA%\huqan` on
 * Windows, `~/.local/state/huqan` elsewhere). Install-dir paths are never the
 * default, so a read-only install can still export.
 */
function resolveStateRoot(environment = process.env) {
  const override = environment && typeof environment.HUQAN_STATE_ROOT === 'string'
    ? environment.HUQAN_STATE_ROOT.trim()
    : '';
  if (override) return path.resolve(override);
  const base = process.platform === 'win32' && environment && environment.LOCALAPPDATA
    ? environment.LOCALAPPDATA
    : path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'huqan');
}

function resolveReceiptsDir(environment = process.env) {
  return path.join(resolveStateRoot(environment), 'receipts');
}

function resolveGateTelemetryPath(environment = process.env) {
  return path.join(resolveStateRoot(environment), 'gate-telemetry.json');
}

function canWriteTo(targetPath, kind = 'file') {
  try {
    return probeWritablePathSync(targetPath, kind);
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
  resolveStateRoot,
  resolveReceiptsDir,
  resolveGateTelemetryPath,
};

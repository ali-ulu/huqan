// The backup store on disk: directory and file copies, the SQLite online
// backup (a child process), listing, pruning and the manifest. Moved out of
// backupRestore.js (#2168).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

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
  const result = spawnSync(process.execPath, ['-e', program, source, destination], { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error(`SQLite online backup failed: ${(result.stderr || result.stdout || '').trim()}`);
  return { name: path.basename(source), size: fs.statSync(destination).size };
}

function readBackupEntries(backupBaseDir, { includeStaging = false } = {}) {
  if (!fs.existsSync(backupBaseDir)) return [];
  return fs.readdirSync(backupBaseDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && (includeStaging || !entry.name.startsWith('.staging-')))
    .map(entry => {
      const dir = path.join(backupBaseDir, entry.name);
      let createdAt = 0;
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
        const parsed = Date.parse(manifest.createdAt);
        createdAt = Number.isFinite(parsed) ? parsed : 0;
      } catch (_) {
        createdAt = 0;
      }
      return {
        dir,
        createdAt,
        isStaging: entry.name.startsWith('.staging-'),
        isSafety: entry.name.startsWith('pre-restore-'),
      };
    });
}

function sortBackupEntriesNewestFirst(left, right) {
  return right.createdAt - left.createdAt || right.dir.localeCompare(left.dir);
}

function sortBackupEntriesOldestFirst(left, right) {
  return left.createdAt - right.createdAt || left.dir.localeCompare(right.dir);
}

function pruneOldBackups(backupBaseDir, keepLast = 10) {
  const keep = Math.max(1, Number(keepLast) || 10);
  const entries = readBackupEntries(backupBaseDir, { includeStaging: true });
  if (!entries.length) return [];

  const staging = entries.filter(entry => entry.isStaging);
  const regular = entries.filter(entry => !entry.isStaging && !entry.isSafety).sort(sortBackupEntriesOldestFirst);
  const safety = entries.filter(entry => !entry.isStaging && entry.isSafety).sort(sortBackupEntriesOldestFirst);
  const stale = [
    ...staging,
    ...regular.slice(0, Math.max(0, regular.length - keep)),
    ...safety.slice(0, Math.max(0, safety.length - keep)),
  ].map(entry => entry.dir);

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

module.exports = {
  ensureDir,
  copyIfExists,
  backupSqliteIfExists,
  readBackupEntries,
  sortBackupEntriesNewestFirst,
  sortBackupEntriesOldestFirst,
  pruneOldBackups,
  writeManifest,
};

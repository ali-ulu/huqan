// Resolving and validating a restore source before anything is replaced:
// the source inside the backup root, file digests and
// SQLite/JSON persistence checks (the SQLite check runs in a child process).
// Moved out of backupRestore.js (#2168).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { resolvePathWithinRoot } = require('../path-safety');
const { resolveRuntimePaths } = require('./backup-restore-paths');
const { listBackups } = require('./backup-restore-create');

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
  const backups = listBackups(opts)
    .filter(dir => !path.basename(dir).startsWith('pre-restore-'));
  return backups[0] || null;
}

function fileDigest(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function validateSqlitePersistenceFile(filePath) {
  const program = [
    "const Database=require('better-sqlite3');",
    "const db=new Database(process.argv[1],{readonly:true,fileMustExist:true});",
    "const integrity=db.pragma('integrity_check',{simple:true});",
    "const profiles=[",
    "{tables:['nodes','edges','audit_log','candidate_claims','mutation_journal','mutation_receipts'],jsonColumns:{nodes:['vector','provenance'],edges:['evidence','confidence_history','provenance','meta'],candidate_claims:['proposed_edge','provenance','conflict','warnings'],audit_log:['details'],mutation_journal:['result'],mutation_receipts:['canonical_payload']}},",
    "{tables:['checkpoints','goal_memory','agent_runs','tool_approvals'],jsonColumns:{checkpoints:['state_json','evidence_json'],goal_memory:['pattern_json'],agent_runs:['state_json'],tool_approvals:['context_json','policy_json']}},",
    "];",
    "const tables=new Set(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all().map(row=>row.name));",
    "const profile=profiles.find(candidate=>candidate.tables.every(name=>tables.has(name)));",
    "if(integrity!=='ok'||!profile){console.error('SQLite integrity/schema validation failed');db.close();process.exitCode=2;}else{",
    "for(const [table,columns] of Object.entries(profile.jsonColumns)){for(const row of db.prepare('SELECT '+columns.join(',')+' FROM '+table).all()){for(const column of columns){const value=row[column];JSON.parse(value===null||value===''?'null':value);}}}",
    "db.close();}",
  ].join('');
  const result = spawnSync(process.execPath, ['-e', program, filePath], { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) {
    return { valid: false, reason: (result.stderr || result.stdout || 'SQLite integrity/schema validation failed').trim() };
  }
  return { valid: true, reason: null };
}

function validateJsonPersistenceFile(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (value === null || typeof value !== 'object') {
      return { valid: false, reason: 'JSON persistence artifact must contain an object or array' };
    }
    return { valid: true, reason: null };
  } catch (error) {
    return { valid: false, reason: `JSON parse failed: ${error.message}` };
  }
}

function validateRestoreSource(sourceDir, runtime) {
  for (const destination of runtime.files) {
    const name = path.basename(destination);
    const source = path.join(sourceDir, name);
    if (!fs.existsSync(source)) continue;
    if (name === 'memory.db') {
      const header = fs.readFileSync(source, { encoding: null }).subarray(0, 16).toString('utf8');
      if (header !== 'SQLite format 3\u0000') {
        return { valid: false, file: name, reason: 'memory.db is not a SQLite database' };
      }
      const result = validateSqlitePersistenceFile(source);
      if (!result.valid) return { valid: false, file: name, reason: result.reason };
    } else if (name === 'memory.json' || destination === runtime.journalPath) {
      const result = validateJsonPersistenceFile(source);
      if (!result.valid) return { valid: false, file: name, reason: result.reason };
    }
  }
  return { valid: true, file: null, reason: null };
}

module.exports = {
  resolveRestoreSource,
  fileDigest,
  validateSqlitePersistenceFile,
  validateJsonPersistenceFile,
  validateRestoreSource,
};

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createBackup, listBackups, restoreBackup } = require('./backupRestore');

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-backup-'));
}

describe('backupRestore', () => {
  it('creates a timestamped backup with manifest', () => {
    const rootDir = makeTempRoot();
    const backupBaseDir = path.join(rootDir, 'backups');
    fs.writeFileSync(path.join(rootDir, 'memory.json'), JSON.stringify({ ok: true }));
    fs.writeFileSync(path.join(rootDir, 'memory.db'), 'db');

    const result = createBackup({ rootDir, backupBaseDir, keepLast: 3 });
    assert.strictEqual(result.ok, true);
    assert.ok(fs.existsSync(result.backupDir));
    assert.ok(fs.existsSync(path.join(result.backupDir, 'manifest.json')));
    assert.ok(fs.existsSync(path.join(result.backupDir, 'memory.json')));
    assert.ok(result.copied.length >= 2);
  });

  it('restores files and creates a safety backup', () => {
    const rootDir = makeTempRoot();
    const backupBaseDir = path.join(rootDir, 'backups');
    const memoryPath = path.join(rootDir, 'memory.json');
    fs.writeFileSync(memoryPath, JSON.stringify({ version: 1 }));
    fs.writeFileSync(path.join(rootDir, 'memory.db'), 'db-v1');

    const backup = createBackup({ rootDir, backupBaseDir, backupId: 'seed', keepLast: 5 });
    fs.writeFileSync(memoryPath, JSON.stringify({ version: 2 }));
    fs.writeFileSync(path.join(rootDir, 'memory.db'), 'db-v2');

    const restored = restoreBackup({ rootDir, backupBaseDir, backupDir: backup.backupDir, keepLast: 5 });
    const data = JSON.parse(fs.readFileSync(memoryPath, 'utf8'));
    assert.strictEqual(restored.ok, true);
    assert.strictEqual(data.version, 1);
    assert.ok(fs.existsSync(restored.safetyBackupDir));
    assert.ok(restored.restored.includes('memory.json'));
  });

  it('lists newest backups first', () => {
    const rootDir = makeTempRoot();
    const backupBaseDir = path.join(rootDir, 'backups');
    fs.writeFileSync(path.join(rootDir, 'memory.json'), JSON.stringify({ ok: true }));

    createBackup({ rootDir, backupBaseDir, backupId: '20260529_100000', keepLast: 5 });
    createBackup({ rootDir, backupBaseDir, backupId: '20260529_110000', keepLast: 5 });

    const backups = listBackups({ rootDir, backupBaseDir });
    assert.strictEqual(path.basename(backups[0]), '20260529_110000');
    assert.strictEqual(path.basename(backups[1]), '20260529_100000');
  });

  it('uses AXIOM_BACKUP_DIR when no backup dir is passed', () => {
    const rootDir = makeTempRoot();
    const backupBaseDir = path.join(rootDir, 'persistent-backups');
    const original = process.env.AXIOM_BACKUP_DIR;
    process.env.AXIOM_BACKUP_DIR = backupBaseDir;
    fs.writeFileSync(path.join(rootDir, 'memory.json'), JSON.stringify({ ok: true }));
    try {
      const result = createBackup({ rootDir });
      assert.ok(result.backupDir.startsWith(backupBaseDir));
    } finally {
      if (original === undefined) delete process.env.AXIOM_BACKUP_DIR;
      else process.env.AXIOM_BACKUP_DIR = original;
    }
  });

  it('createBackup carries a complete operation receipt and leaves no staging directory', () => {
    const rootDir = makeTempRoot();
    const backupBaseDir = path.join(rootDir, 'backups');
    fs.writeFileSync(path.join(rootDir, 'memory.json'), JSON.stringify({ ok: true }));

    const result = createBackup({ rootDir, backupBaseDir, backupId: 'r1', keepLast: 5 });
    assert.strictEqual(result.receipt.status, 'complete');
    assert.strictEqual(result.receipt.kind, 'backup');
    assert.ok(result.receipt.operationId);
    assert.deepStrictEqual(result.manifest.receipt, result.receipt);

    const entries = fs.readdirSync(backupBaseDir);
    assert.ok(!entries.some(name => name.startsWith('.staging-')), 'no staging directory should remain after success');
  });

  it('createBackup atomically leaves no partial backup directory when a copy step fails', () => {
    const rootDir = makeTempRoot();
    const backupBaseDir = path.join(rootDir, 'backups');
    fs.writeFileSync(path.join(rootDir, 'memory.json'), JSON.stringify({ ok: true }));
    // memory.db as a directory forces fs.copyFileSync to throw mid-loop.
    fs.mkdirSync(path.join(rootDir, 'memory.db'));

    assert.throws(() => createBackup({ rootDir, backupBaseDir, backupId: 'r2', keepLast: 5 }));

    assert.ok(!fs.existsSync(path.join(backupBaseDir, 'r2')), 'failed backup must not appear under its final name');
    const entries = fs.existsSync(backupBaseDir) ? fs.readdirSync(backupBaseDir) : [];
    assert.ok(!entries.some(name => name.startsWith('.staging-')), 'staging directory must be cleaned up on failure');
  });

  it('restoreBackup carries a complete operation receipt', () => {
    const rootDir = makeTempRoot();
    const backupBaseDir = path.join(rootDir, 'backups');
    const memoryPath = path.join(rootDir, 'memory.json');
    fs.writeFileSync(memoryPath, JSON.stringify({ version: 1 }));

    const backup = createBackup({ rootDir, backupBaseDir, backupId: 'seed2', keepLast: 5 });
    fs.writeFileSync(memoryPath, JSON.stringify({ version: 2 }));

    const restored = restoreBackup({ rootDir, backupBaseDir, backupDir: backup.backupDir, keepLast: 5 });
    assert.strictEqual(restored.receipt.status, 'complete');
    assert.strictEqual(restored.receipt.kind, 'restore');
    assert.deepStrictEqual(restored.receipt.restored, restored.restored);
  });

  it('restoreBackup stops on the first failure and reports a partial receipt without retrying', () => {
    const rootDir = makeTempRoot();
    const backupBaseDir = path.join(rootDir, 'backups');
    const memoryPath = path.join(rootDir, 'memory.json');
    const dbPath = path.join(rootDir, 'memory.db');
    fs.writeFileSync(memoryPath, JSON.stringify({ version: 1 }));
    fs.writeFileSync(dbPath, 'db-v1');

    const backup = createBackup({ rootDir, backupBaseDir, backupId: 'seed3', keepLast: 5 });
    fs.writeFileSync(memoryPath, JSON.stringify({ version: 2 }));
    fs.writeFileSync(dbPath, 'db-v2');

    // Fail the SECOND rename the restore loop performs (dbPath's rename
    // succeeds first, memoryPath's rename then throws), without touching the
    // safety backup's own (earlier) rename call.
    const originalRename = fs.renameSync;
    let renameCalls = 0;
    fs.renameSync = (...args) => {
      renameCalls += 1;
      if (renameCalls === 3) throw new Error('simulated rename failure');
      return originalRename(...args);
    };

    let caught = null;
    try {
      restoreBackup({ rootDir, backupBaseDir, backupDir: backup.backupDir, keepLast: 5 });
    } catch (error) {
      caught = error;
    } finally {
      fs.renameSync = originalRename;
    }

    assert.ok(caught, 'restoreBackup must throw on a partial failure');
    assert.strictEqual(caught.receipt.status, 'partial');
    assert.ok(caught.receipt.restored.includes('memory.db'), 'files restored before the failure must be recorded');
    assert.ok(!caught.receipt.restored.includes('memory.json'), 'the failing file must not be recorded as restored');
    assert.ok(fs.existsSync(caught.receipt.safetyBackupDir), 'safety backup must exist as the recovery path');
    assert.strictEqual(fs.readFileSync(dbPath, 'utf8'), 'db-v1', 'the successfully restored file must reflect the backup, not the pre-restore (v2) state');
    assert.strictEqual(JSON.parse(fs.readFileSync(memoryPath, 'utf8')).version, 2, 'the failed file must be left untouched at its pre-restore state');
  });
});

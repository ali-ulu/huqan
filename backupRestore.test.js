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
});

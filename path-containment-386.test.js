const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CLI = require('./cli');
const { createBackup, restoreBackup } = require('./backupRestore');

function withCleanCliRoots(fn) {
  const previous = process.env.AXIOM_CLI_READ_ROOTS;
  delete process.env.AXIOM_CLI_READ_ROOTS;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.AXIOM_CLI_READ_ROOTS;
    else process.env.AXIOM_CLI_READ_ROOTS = previous;
  }
}

function makeCli() {
  return new CLI({ kernel: { noLoad: true, useSQLite: false, loadPlugins: false } });
}

function makeOutsideDir(prefix) {
  return fs.mkdtempSync(path.join(os.homedir(), prefix));
}

function symlinkOrSkip(t, target, linkPath, type = 'file') {
  try {
    fs.symlinkSync(target, linkPath, type);
    return true;
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip(`symlink creation unavailable: ${error.code}`);
      return false;
    }
    throw error;
  }
}

test('CLI yükle rejects a path outside configured read roots (#386)', () => withCleanCliRoots(() => {
  const outsideDir = makeOutsideDir('.huqan-cli-outside-');
  try {
    const secretPath = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(secretPath, 'gizli kedi bilgisi');
    const result = makeCli().execute('yükle', secretPath, { gateResult: { canExecute: true } });
    assert.match(result, /izin verilen dizinlerin disinda/i);
  } finally {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
}));

test('CLI yükle rejects an allowed-root symlink whose target escapes (#386)', (t) => withCleanCliRoots(() => {
  const allowedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cli-link-'));
  const outsideDir = makeOutsideDir('.huqan-cli-link-outside-');
  try {
    const outsidePath = path.join(outsideDir, 'secret.txt');
    const linkPath = path.join(allowedDir, 'secret.txt');
    fs.writeFileSync(outsidePath, 'gizli kedi bilgisi');
    if (!symlinkOrSkip(t, outsidePath, linkPath)) return;

    const result = makeCli().execute('yükle', linkPath, { gateResult: { canExecute: true } });
    assert.match(result, /izin verilen dizinlerin disinda/i);
  } finally {
    fs.rmSync(allowedDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
}));

test('CLI yükle still reads a normal file under the temp root (#386)', () => withCleanCliRoots(() => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cli-ok-'));
  try {
    const filePath = path.join(tempDir, 'notes.txt');
    fs.writeFileSync(filePath, 'kedi hayvandir');
    const result = makeCli().execute('yükle', filePath, { gateResult: { canExecute: true } });
    assert.match(result, /dosyasından \d+ bilgi öğrenildi/i);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}));

test('restore rejects a backupDir outside the configured backup root (#386)', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-restore-root-'));
  const rogueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-restore-rogue-'));
  const backupBaseDir = path.join(rootDir, 'backups');
  try {
    fs.writeFileSync(path.join(rootDir, 'memory.json'), JSON.stringify({ version: 1 }));
    createBackup({ rootDir, backupBaseDir, keepLast: 5 });
    fs.writeFileSync(path.join(rogueDir, 'memory.json'), JSON.stringify({ planted: true }));

    assert.throws(
      () => restoreBackup({ rootDir, backupBaseDir, backupDir: rogueDir, keepLast: 5 }),
      error => error && error.code === 'RESTORE_SOURCE_NOT_ALLOWED',
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(rogueDir, { recursive: true, force: true });
  }
});

test('restore rejects a backup-root symlink whose target escapes (#386)', (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-restore-link-root-'));
  const backupBaseDir = path.join(rootDir, 'backups');
  const rogueDir = path.join(rootDir, 'rogue');
  try {
    fs.mkdirSync(backupBaseDir, { recursive: true });
    fs.mkdirSync(rogueDir, { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'memory.json'), JSON.stringify({ version: 1 }));
    fs.writeFileSync(path.join(rogueDir, 'memory.json'), JSON.stringify({ planted: true }));

    const linkPath = path.join(backupBaseDir, 'escaped');
    if (!symlinkOrSkip(t, rogueDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir')) return;

    assert.throws(
      () => restoreBackup({ rootDir, backupBaseDir, backupDir: linkPath, keepLast: 5 }),
      error => error && error.code === 'RESTORE_SOURCE_NOT_ALLOWED',
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

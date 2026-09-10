'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBackup, previewRestore, restoreBackup, formatRestoreError } = require('../backupRestore');
const { publicWorkflowManifest } = require('../lib/workflow-contract');
const { CLI_MUTATION_GATE } = require('../lib/cli-mutation-gate');

function fixture() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-restore-workflow-'));
  const opts = {
    rootDir,
    memoryPath: path.join(rootDir, 'memory.json'),
    dbPath: path.join(rootDir, 'memory.db'),
    backupBaseDir: path.join(rootDir, 'backups'),
  };
  fs.writeFileSync(opts.memoryPath, '{"fact":"before"}');
  return { rootDir, opts };
}

test('restore dry-run previews manifest scope and conflicts without mutation', () => {
  const { rootDir, opts } = fixture();
  try {
    const backup = createBackup({ ...opts, backupId: 'source' });
    fs.writeFileSync(opts.memoryPath, '{"fact":"after"}');
    const before = fs.readFileSync(opts.memoryPath, 'utf8');
    const preview = previewRestore({ ...opts, backupDir: backup.backupDir });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.schemaVersion, 1);
    assert.ok(preview.scope.files.some(file => file.name === 'memory.json' && file.action === 'replace'));
    assert.deepEqual(preview.conflicts, ['memory.json']);
    assert.equal(fs.readFileSync(opts.memoryPath, 'utf8'), before);
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

test('restore creates a safety backup and verifies restored persistence and receipt', () => {
  const { rootDir, opts } = fixture();
  try {
    const backup = createBackup({ ...opts, backupId: 'source' });
    fs.writeFileSync(opts.memoryPath, '{"fact":"after"}');
    const result = restoreBackup({ ...opts, backupDir: backup.backupDir });
    assert.ok(fs.existsSync(result.safetyBackupDir));
    assert.deepEqual(result.verification, { persistence: true, schema: true, graphIntegrity: true, receipt: true });
    assert.equal(result.receipt.status, 'complete');
    assert.equal(fs.readFileSync(opts.memoryPath, 'utf8'), '{"fact":"before"}');
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

test('restore refuses to retry after an interrupted operation marker', () => {
  const { rootDir, opts } = fixture();
  try {
    fs.writeFileSync(path.join(rootDir, '.restore-progress.json'), JSON.stringify({ status: 'in_progress', safetyBackupDir: 'pre-restore-test' }));
    assert.throws(() => restoreBackup({ ...opts, backupDir: path.join(rootDir, 'missing') }), error => error.code === 'RESTORE_INTERRUPTED' && error.receipt.safetyBackupDir === 'pre-restore-test');
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

test('restore parser and manifest expose dry-run and maintenance capability boundaries', () => {
  const parsed = require('../lib/command-parser').parseCommand('restore --dry-run C:\\backup');
  assert.equal(parsed.workflowId, 'restore');
  assert.deepEqual(parsed.args, { dryRun: true, backupDir: 'C:\\backup' });
  const workflows = new Map(publicWorkflowManifest().workflows.map(item => [item.workflowId, item]));
  assert.equal(workflows.get('restore').capabilityClass, 'operator');
  assert.equal(workflows.get('restore').dryRunRequired, true);
  assert.equal(workflows.get('restore').safetyBackupRequired, true);
  assert.equal(workflows.get('backup').capabilityClass, 'operator');
  assert.equal(workflows.get('auto-think').capabilityClass, 'operator');
  assert.equal(workflows.get('consolidate').capabilityClass, 'operator');
  assert.equal(workflows.get('evolve').capabilityClass, 'admin');
  assert.equal(CLI_MUTATION_GATE.restore.mutationType, 'state_replace');
});

test('formatRestoreError surfaces the partial receipt (H-08, #1981)', () => {
  const error = new Error('simulated rename failure');
  error.receipt = {
    operationId: 'restoreop_1',
    kind: 'restore',
    status: 'partial',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    sourceDir: '/tmp/backups/seed',
    restored: ['memory.json'],
    skipped: [],
    safetyBackupDir: '/tmp/backups/pre-restore-abc',
    message: 'simulated rename failure',
  };
  const output = formatRestoreError(error);
  assert.ok(output.includes('simulated rename failure'), 'message must be present');
  assert.ok(output.includes('partial'), 'status must be present');
  assert.ok(output.includes('memory.json'), 'restored files must be present');
  assert.ok(output.includes('/tmp/backups/pre-restore-abc'), 'safetyBackupDir must be present');
});

test('formatRestoreError without a receipt falls back to the plain message (RESTORE_SOURCE_INVALID stays untouched)', () => {
  const error = new Error('Restore source validation failed for memory.json: JSON parse failed');
  error.code = 'RESTORE_SOURCE_INVALID';
  const output = formatRestoreError(error);
  assert.equal(output, `Restore hatasi: ${error.message}`);
});

test('CLI restore surfaces the partial receipt instead of only the message (H-08, #1981)', () => {
  const CLI = require('../cli');
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cli-restore-partial-'));
  const memoryPath = path.join(rootDir, 'memory.json');
  const cli = new CLI({
    kernel: {
      memoryPath,
      dbPath: path.join(rootDir, 'memory.db'),
      noLoad: true,
      useSQLite: false,
      memoryStoreUseSQLite: false,
      loadPlugins: false,
    },
  });
  cli.agent.storage.close();
  const originalRename = fs.renameSync;
  try {
    fs.writeFileSync(memoryPath, JSON.stringify({ version: 1 }), 'utf8');
    fs.writeFileSync(path.join(rootDir, 'memory.embeddings.json'), 'embedding-v1', 'utf8');
    cli.execute('backup', '');
    fs.writeFileSync(memoryPath, JSON.stringify({ version: 2 }), 'utf8');

    // Fail only the embedding sidecar replace, after the safety backup ran.
    fs.renameSync = (from, to, ...rest) => {
      if (String(to).endsWith('memory.embeddings.json')) throw new Error('simulated rename failure');
      return originalRename.call(fs, from, to, ...rest);
    };

    let caught = null;
    try {
      cli.execute('restore', '');
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, 'CLI restore must throw on a partial failure');
    assert.equal(caught.receipt.status, 'partial');
    assert.ok(caught.message.includes('partial'), 'thrown message must carry the receipt status');
    assert.ok(caught.message.includes('memory.json'), 'thrown message must list restored files');
    assert.ok(caught.message.includes(caught.receipt.safetyBackupDir), 'thrown message must show the safety backup recovery path');
    assert.ok(fs.existsSync(caught.receipt.safetyBackupDir), 'safety backup must exist as the recovery path');
  } finally {
    fs.renameSync = originalRename;
    if (cli?.approvalStore && typeof cli.approvalStore.close === 'function') cli.approvalStore.close();
    try { cli.agent.storage.close(); } catch (_) {}
    try { cli.kernel.graph.close(); } catch (_) {}
    try { cli.kernel.memory.close(); } catch (_) {}
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('scripts/restore.js prints the partial receipt on stderr (H-08, #1981)', { skip: process.platform !== 'win32' }, () => {
  // Windows-only injection: chmod 444 makes the atomic tmp-file rename over
  // the destination fail with EPERM. On POSIX rename needs only directory
  // write permission, so the restore would complete and this scenario could
  // not trigger; the POSIX error surface is covered by the in-process
  // rename-injection test above.
  const { spawnSync } = require('node:child_process');
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-script-restore-partial-'));
  const envKeys = ['MEMORY_PATH', 'DB_PATH', 'BACKUP_DIR'];
  const previousEnv = new Map();
  for (const key of [...envKeys.map(k => `AXIOM_${k}`), ...envKeys.map(k => `HUQAN_${k}`)]) {
    previousEnv.set(key, { present: Object.prototype.hasOwnProperty.call(process.env, key), value: process.env[key] });
    delete process.env[key];
  }
  const embeddingPath = path.join(rootDir, 'memory.embeddings.json');
  try {
    fs.writeFileSync(path.join(rootDir, 'memory.json'), JSON.stringify({ version: 1 }), 'utf8');
    fs.writeFileSync(embeddingPath, 'embedding-v1', 'utf8');
    const backup = createBackup({ rootDir, backupId: 'seed' });
    fs.writeFileSync(path.join(rootDir, 'memory.json'), JSON.stringify({ version: 2 }), 'utf8');
    // Read-only destination: the safety backup can still read it, but the
    // atomic tmp-file rename over it fails, forcing a partial restore.
    fs.chmodSync(embeddingPath, 0o444);

    const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'restore.js'), backup.backupDir], {
      cwd: rootDir,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, `script must exit 1, got ${result.status}: ${result.stderr}`);
    assert.ok(result.stderr.includes('partial'), `stderr must carry the receipt status: ${result.stderr}`);
    assert.ok(result.stderr.includes('memory.json'), `stderr must list restored files: ${result.stderr}`);
    assert.ok(result.stderr.includes('Guvenlik yedegi'), `stderr must show the safety backup path: ${result.stderr}`);
    const safetyDirs = fs.readdirSync(path.join(rootDir, 'backups')).filter(name => name.startsWith('pre-restore-'));
    assert.ok(safetyDirs.length > 0, 'safety backup must exist as the recovery path');
    assert.ok(safetyDirs.some(name => result.stderr.includes(name)), `stderr must name the safety backup dir: ${result.stderr}`);
  } finally {
    for (const [key, snapshot] of previousEnv) {
      if (snapshot.present) process.env[key] = snapshot.value;
      else delete process.env[key];
    }
    try { fs.chmodSync(embeddingPath, 0o666); } catch (_) {}
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

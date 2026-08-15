'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBackup, previewRestore, restoreBackup } = require('../backupRestore');
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
  fs.writeFileSync(opts.dbPath, 'sqlite-before');
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
  assert.equal(workflows.get('optimize').capabilityClass, 'operator');
  assert.equal(workflows.get('consolidate').capabilityClass, 'operator');
  assert.equal(workflows.get('evolve').capabilityClass, 'admin');
  assert.equal(CLI_MUTATION_GATE.restore.mutationType, 'state_replace');
});

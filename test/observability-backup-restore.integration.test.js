'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const HuqanStorage = require('../storage');
const { createObservabilityService } = require('../lib/observability/service');
const { createBackup, restoreBackup } = require('../backupRestore');

function makeHarness(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-observability-backup-'));
  const opts = {
    rootDir,
    memoryPath: path.join(rootDir, 'memory.json'),
    dbPath: path.join(rootDir, 'memory.db'),
    backupBaseDir: path.join(rootDir, 'backups'),
  };
  fs.writeFileSync(opts.memoryPath, JSON.stringify({ version: 1 }));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return { rootDir, opts };
}

test('SQLite backup and restore preserves observability state and workspace scope', t => {
  const { rootDir, opts } = makeHarness(t);
  const storage = new HuqanStorage({ dbPath: opts.dbPath });
  const service = createObservabilityService({ db: storage.db });
  try {
    service.recordRunStart({ workspaceId: 'workspace-a', runId: 'run-a', traceId: 'trace-a', goal: 'safe fixture goal' });
    service.recordStep({ workspaceId: 'workspace-a', runId: 'run-a', traceId: 'trace-a', tool: 'verify', status: 'done' });
    service.recordRunFinish({
      workspaceId: 'workspace-a', runId: 'run-a', traceId: 'trace-a', status: 'completed',
      startedAt: 1_700_000_000_000, finishedAt: 1_700_000_001_000, durationMs: 1_000,
    });
    service.createAlertRule({
      workspaceId: 'workspace-a', ruleId: 'rule-a', metric: 'queue_depth', operator: 'gt', threshold: -1,
    });
    service.recordStep({ workspaceId: 'workspace-a', runId: 'run-a', traceId: 'trace-a', tool: 'verify-after-rule', status: 'done' });
    service.enqueueJob({ workspaceId: 'workspace-a', jobId: 'job-a', goal: 'safe queue fixture', maxSteps: 1 });
    service.recordStep({ workspaceId: 'workspace-b', runId: 'run-b', traceId: 'trace-b', tool: 'verify', status: 'done' });
  } finally {
    storage.close();
  }

  const backup = createBackup({ ...opts, backupId: 'observability-source', keepLast: 5 });
  assert.ok(backup.manifest.files.includes('memory.db'));

  const mutated = new HuqanStorage({ dbPath: opts.dbPath });
  try {
    mutated.db.exec('DELETE FROM observability_events; DELETE FROM observability_alerts; DELETE FROM observability_alert_rules; DELETE FROM observability_runs; DELETE FROM agent_queue_jobs;');
    fs.writeFileSync(opts.memoryPath, JSON.stringify({ version: 2 }));
  } finally {
    mutated.close();
  }

  const restored = restoreBackup({ ...opts, backupDir: backup.backupDir, keepLast: 5 });
  assert.deepEqual(restored.verification, {
    persistence: true,
    schema: true,
    graphIntegrity: true,
    receipt: true,
  });
  assert.equal(JSON.parse(fs.readFileSync(opts.memoryPath, 'utf8')).version, 1);

  const after = new HuqanStorage({ dbPath: opts.dbPath });
  const restoredService = createObservabilityService({ db: after.db });
  try {
    const events = restoredService.listEvents({ workspaceId: 'workspace-a', limit: 50 }).items;
    assert.ok(events.some(event => event.eventType === 'run_started'));
    assert.ok(events.some(event => event.eventType === 'step_finished'));
    assert.ok(events.some(event => event.eventType === 'run_finished'));
    assert.ok(events.some(event => event.eventType === 'queue_enqueued'));
    assert.ok(events.some(event => event.eventType === 'alert_firing'));
    assert.equal(restoredService.listRuns({ workspaceId: 'workspace-a' }).items[0].runId, 'run-a');
    assert.equal(restoredService.listQueue({ workspaceId: 'workspace-a' })[0].jobId, 'job-a');
    assert.equal(restoredService.listQueue({ workspaceId: 'workspace-a' })[0].status, 'queued');
    assert.equal(restoredService.listAlertRules({ workspaceId: 'workspace-a' })[0].ruleId, 'rule-a');
    assert.equal(restoredService.listAlerts({ workspaceId: 'workspace-a' })[0].workspaceId, 'workspace-a');
    assert.equal(restoredService.listEvents({ workspaceId: 'workspace-b' }).items.length, 1);
    assert.equal(restoredService.listEvents({ workspaceId: 'workspace-c' }).items.length, 0);
  } finally {
    after.close();
  }
});

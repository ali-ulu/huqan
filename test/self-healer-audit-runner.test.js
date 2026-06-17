const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const {
  createAuditReport,
  createAuditReportId,
  runSelfHealerAudit,
  validateAuditOptions,
} = require('../lib/self-healer/audit-runner');
const { validateFinding } = require('../lib/self-healer/finding-schema');

const safeRepoRoot = process.platform === 'win32'
  ? 'C:/safe/repo'
  : '/safe/repo';

function baseCheck(overrides = {}) {
  return {
    kind: 'security',
    severity: 'high',
    confidence: 0.8,
    title: 'Public route bypass',
    summary: 'Example finding',
    evidence: [
      { type: 'route', ref: 'GET /api', detail: 'unguarded route' },
    ],
    affectedFiles: ['server.js'],
    suggestedTests: ['node --test server.test.js'],
    ...overrides,
  };
}

function baseInput(overrides = {}) {
  return {
    workspaceId: 'default',
    repoRoot: safeRepoRoot,
    mode: 'audit_only',
    checks: [baseCheck()],
    ...overrides,
  };
}

describe('self-healer audit runner dry run', () => {
  let execCalls;
  let spawnCalls;
  let writeCalls;
  let originalExecFileSync;
  let originalExecSync;
  let originalSpawnSync;
  let originalWriteFileSync;

  beforeEach(() => {
    execCalls = 0;
    spawnCalls = 0;
    writeCalls = 0;
    originalExecFileSync = cp.execFileSync;
    originalExecSync = cp.execSync;
    originalSpawnSync = cp.spawnSync;
    originalWriteFileSync = fs.writeFileSync;
    cp.execFileSync = (...args) => {
      execCalls += 1;
      return originalExecFileSync(...args);
    };
    cp.execSync = (...args) => {
      execCalls += 1;
      return originalExecSync(...args);
    };
    cp.spawnSync = (...args) => {
      spawnCalls += 1;
      return originalSpawnSync(...args);
    };
    fs.writeFileSync = (...args) => {
      writeCalls += 1;
      return originalWriteFileSync(...args);
    };
  });

  afterEach(() => {
    cp.execFileSync = originalExecFileSync;
    cp.execSync = originalExecSync;
    cp.spawnSync = originalSpawnSync;
    fs.writeFileSync = originalWriteFileSync;
  });

  it('runs in audit_only mode', () => {
    const report = runSelfHealerAudit(baseInput());
    assert.strictEqual(report.mode, 'audit_only');
    assert.strictEqual(report.status, 'ready');
    assert.strictEqual(report.findingCount, 1);
    assert.ok(report.reportId.startsWith('audit_'));
  });

  it('rejects draft_patch', () => {
    assert.throws(() => runSelfHealerAudit(baseInput({ mode: 'draft_patch' })), /Invalid audit options/);
  });

  it('rejects draft_pr', () => {
    assert.throws(() => runSelfHealerAudit(baseInput({ mode: 'draft_pr' })), /Invalid audit options/);
  });

  it('rejects proposal_only', () => {
    assert.throws(() => runSelfHealerAudit(baseInput({ mode: 'proposal_only' })), /Invalid audit options/);
  });

  it('returns empty report for empty checks', () => {
    const report = runSelfHealerAudit(baseInput({ checks: [] }));
    assert.strictEqual(report.findingCount, 0);
    assert.deepStrictEqual(report.findings, []);
  });

  it('normalizes check into valid finding', () => {
    const report = runSelfHealerAudit(baseInput());
    assert.ok(validateFinding(report.findings[0]).ok);
    assert.strictEqual(report.findings[0].workspaceId, 'default');
  });

  it('preserves workspaceId', () => {
    const report = runSelfHealerAudit(baseInput({ workspaceId: 'workspace-a' }));
    assert.strictEqual(report.workspaceId, 'workspace-a');
    assert.strictEqual(report.findings[0].workspaceId, 'workspace-a');
  });

  it('defaults workspaceId to default', () => {
    const report = runSelfHealerAudit({
      repoRoot: safeRepoRoot,
      mode: 'audit_only',
      checks: [baseCheck()],
    });
    assert.strictEqual(report.workspaceId, 'default');
  });

  it('report findingCount matches findings length', () => {
    const report = runSelfHealerAudit(baseInput({ checks: [baseCheck(), baseCheck({ title: 'Another finding' })] }));
    assert.strictEqual(report.findingCount, report.findings.length);
  });

  it('produces deterministic reportId for same input', () => {
    const input = baseInput();
    const first = createAuditReportId({
      workspaceId: input.workspaceId,
      mode: input.mode,
      repoRoot: input.repoRoot,
      findings: [baseCheck()],
    });
    const second = createAuditReportId({
      workspaceId: input.workspaceId,
      mode: input.mode,
      repoRoot: input.repoRoot,
      findings: [baseCheck()],
    });
    assert.strictEqual(first, second);
  });

  it('does not mutate input checks', () => {
    const checks = [baseCheck()];
    const snapshot = JSON.parse(JSON.stringify(checks));
    runSelfHealerAudit(baseInput({ checks }));
    assert.deepStrictEqual(checks, snapshot);
  });

  it('does not write files', () => {
    runSelfHealerAudit(baseInput());
    assert.strictEqual(writeCalls, 0);
  });

  it('does not write memory', () => {
    runSelfHealerAudit(baseInput());
    assert.strictEqual(execCalls, 0);
    assert.strictEqual(spawnCalls, 0);
  });

  it('does not create branch or PR', () => {
    runSelfHealerAudit(baseInput());
    assert.strictEqual(execCalls, 0);
    assert.strictEqual(spawnCalls, 0);
  });

  it('rejects repoRoot traversal', () => {
    const validation = validateAuditOptions({
      workspaceId: 'default',
      repoRoot: '../escape',
      mode: 'audit_only',
    });
    assert.strictEqual(validation.ok, false);
    assert.ok(validation.errors.some((error) => error.field === 'repoRoot'));
  });

  it('rejects invalid check clearly', () => {
    assert.throws(() => runSelfHealerAudit(baseInput({
      checks: [
        baseCheck({ confidence: 1.2 }),
      ],
    })), /Invalid finding/);
  });

  it('security finding fixture validates with SH-1 schema', () => {
    const report = createAuditReport([baseCheck()], {
      workspaceId: 'default',
      repoRoot: safeRepoRoot,
      mode: 'audit_only',
    });
    assert.ok(report.reportId.startsWith('audit_'));
    assert.ok(validateFinding(report.findings[0]).ok);
  });
});

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const {
  classifyConfidence,
  classifyFindingKind,
  classifyRawFinding,
  classifySeverity,
  normalizeClassifiedFinding,
} = require('../lib/self-healer/finding-classifier');
const { validateFinding } = require('../lib/self-healer/finding-schema');

function baseRaw(overrides = {}) {
  return {
    type: 'security',
    title: 'Public route bypass',
    summary: 'GET route bypasses auth guard',
    severitySignal: 'high',
    confidenceSignal: 0.82,
    evidence: [
      { type: 'route', ref: 'GET /api', detail: 'unguarded route' },
    ],
    affectedFiles: ['server.js'],
    suggestedTests: ['node --test server.test.js'],
    workspaceId: 'default',
    ...overrides,
  };
}

describe('self-healer finding classifier', () => {
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

  it('classifies security finding', () => {
    const finding = classifyRawFinding(baseRaw({ type: 'security' }));
    assert.strictEqual(finding.kind, 'security');
    assert.strictEqual(finding.severity, 'high');
  });

  it('classifies bug finding', () => {
    const finding = classifyRawFinding(baseRaw({
      type: 'bug',
      title: 'Incorrect output',
      summary: 'Bug in output formatting',
      severitySignal: undefined,
      evidence: [{ type: 'log', ref: 'run.log', detail: 'unexpected output' }],
      affectedFiles: ['kernel.js'],
    }));
    assert.strictEqual(finding.kind, 'bug');
    assert.strictEqual(finding.severity, 'medium');
  });

  it('classifies flaky test finding', () => {
    const finding = classifyRawFinding(baseRaw({
      type: 'flaky_test',
      title: 'Intermittent test order failure',
      severitySignal: 'low',
      evidence: [{ type: 'test', ref: 'test/memory-graph-links.test.js', detail: 'ordering deviation' }],
      affectedFiles: ['test/memory-graph-links.test.js'],
    }));
    assert.strictEqual(finding.kind, 'flaky_test');
    assert.strictEqual(finding.severity, 'low');
  });

  it('classifies stale docs finding', () => {
    const finding = classifyRawFinding(baseRaw({
      type: 'docs',
      title: 'Roadmap text is stale',
      severitySignal: 'info',
      evidence: [{ type: 'manual', ref: 'docs/self-healer-roadmap.md', detail: 'stale release snapshot' }],
      affectedFiles: ['docs/self-healer-roadmap.md'],
    }));
    assert.strictEqual(finding.kind, 'stale_docs');
    assert.strictEqual(finding.severity, 'info');
  });

  it('classifies unsafe pattern finding', () => {
    const finding = classifyRawFinding(baseRaw({
      type: 'unsafe_pattern',
      title: 'Path traversal pattern',
      severitySignal: 'critical',
      evidence: [{ type: 'file', ref: 'adapters/markdown-adapter.js', detail: 'unsafe join pattern' }],
      affectedFiles: ['adapters/markdown-adapter.js'],
    }));
    assert.strictEqual(finding.kind, 'unsafe_pattern');
    assert.strictEqual(finding.severity, 'critical');
  });

  it('classifies release hygiene finding', () => {
    const finding = classifyRawFinding(baseRaw({
      type: 'release_hygiene',
      title: 'Tag metadata is stale',
      severitySignal: 'low',
      evidence: [{ type: 'commit', ref: 'release notes', detail: 'tag mismatch' }],
      affectedFiles: ['docs/release-v0.9.1.md'],
    }));
    assert.strictEqual(finding.kind, 'release_hygiene');
    assert.strictEqual(finding.severity, 'low');
  });

  it('rejects invalid or empty raw input clearly', () => {
    assert.throws(() => classifyRawFinding(null), /Invalid raw finding input/);
    assert.throws(() => classifyRawFinding({}), /Unable to classify raw finding type/);
  });

  it('preserves evidence', () => {
    const raw = baseRaw({
      evidence: [
        { type: 'log', ref: 'server.js:1', detail: 'auth guard missing' },
        { type: 'route', ref: 'GET /api', detail: 'unsafe route' },
      ],
    });
    const finding = classifyRawFinding(raw);
    assert.deepStrictEqual(finding.evidence, [
      { type: 'log', ref: 'server.js:1', detail: 'auth guard missing' },
      { type: 'route', ref: 'GET /api', detail: 'unsafe route' },
    ]);
  });

  it('preserves affectedFiles', () => {
    const finding = classifyRawFinding(baseRaw({
      affectedFiles: ['server.js', 'server.test.js'],
    }));
    assert.deepStrictEqual(finding.affectedFiles, ['server.js', 'server.test.js']);
  });

  it('severity mapping is deterministic', () => {
    const raw = baseRaw({
      type: 'bug',
      severitySignal: 'medium',
      title: 'Deterministic severity',
    });
    assert.strictEqual(classifySeverity(raw), classifySeverity({ ...raw }));
    assert.strictEqual(classifyFindingKind(raw), classifyFindingKind({ ...raw }));
  });

  it('confidence is bounded between 0 and 1', () => {
    assert.strictEqual(classifyConfidence(baseRaw({ confidenceSignal: -1 })), 0);
    assert.strictEqual(classifyConfidence(baseRaw({ confidenceSignal: 1.5 })), 1);
    const defaultConfidence = classifyConfidence(baseRaw({ confidenceSignal: undefined, confidence: undefined }));
    assert.ok(defaultConfidence >= 0 && defaultConfidence <= 1);
  });

  it('unknown raw type is rejected explicitly', () => {
    assert.throws(() => classifyRawFinding(baseRaw({ type: 'mystery', title: 'Unknown thing' })), /Unable to classify raw finding type/);
  });

  it('output validates with validateFinding', () => {
    const finding = normalizeClassifiedFinding(baseRaw({
      type: 'security',
      title: 'Validated finding',
      evidence: [{ type: 'route', ref: 'GET /v2/verify', detail: 'unsafe GET path' }],
      affectedFiles: ['server.js'],
    }));
    assert.ok(validateFinding(finding).ok);
  });

  it('does not write files', () => {
    classifyRawFinding(baseRaw());
    assert.strictEqual(writeCalls, 0);
  });

  it('does not write memory', () => {
    classifyRawFinding(baseRaw());
    assert.strictEqual(execCalls, 0);
    assert.strictEqual(spawnCalls, 0);
  });

  it('does not create patch or PR behavior', () => {
    classifyRawFinding(baseRaw());
    assert.strictEqual(execCalls, 0);
    assert.strictEqual(spawnCalls, 0);
  });
});

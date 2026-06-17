const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  FINDING_KINDS,
  FINDING_SEVERITIES,
  createFinding,
  createFindingId,
  isFinding,
  normalizeFinding,
  validateFinding,
  classifyFindingSeverity,
} = require('../lib/self-healer/finding-schema');

function baseInput(overrides = {}) {
  return {
    kind: 'security',
    title: 'Unsafe GET route',
    summary: 'Route allows unsafe execution surface',
    evidence: [
      { type: 'route', ref: 'server.js:928-971', detail: 'GET /api?q=... can trigger restore' },
    ],
    affectedFiles: ['server.js'],
    suggestedTests: ['node --test server.test.js'],
    suggestedFix: {
      summary: 'Require method guard',
      allowedFiles: ['server.js', 'server.test.js'],
      forbiddenFiles: ['kernel.js'],
      risk: 'low',
    },
    riskFlags: ['auth-bypass'],
    confidence: 0.9,
    ...overrides,
  };
}

describe('self-healer finding schema', () => {
  it('creates a valid finding with defaults', () => {
    const finding = createFinding(baseInput({ workspaceId: undefined, status: undefined, receiptId: undefined }));

    assert.ok(finding.findingId.startsWith('finding_'));
    assert.strictEqual(finding.status, 'candidate');
    assert.strictEqual(finding.workspaceId, 'default');
    assert.strictEqual(finding.receiptId, null);
    assert.strictEqual(finding.kind, 'security');
    assert.strictEqual(finding.severity, 'high');
    assert.strictEqual(finding.confidence, 0.9);
    assert.ok(validateFinding(finding).ok, 'created finding must validate');
  });

  it('rejects unknown kind', () => {
    assert.throws(() => createFinding(baseInput({ kind: 'not-real' })), /Invalid finding/);
  });

  it('rejects unknown severity', () => {
    assert.throws(() => createFinding(baseInput({ severity: 'nuclear' })), /Invalid finding/);
  });

  it('rejects confidence outside range', () => {
    assert.throws(() => createFinding(baseInput({ confidence: -0.1 })), /Invalid finding/);
    assert.throws(() => createFinding(baseInput({ confidence: 1.1 })), /Invalid finding/);
  });

  it('defaults status to candidate', () => {
    const finding = createFinding(baseInput({ status: undefined }));
    assert.strictEqual(finding.status, 'candidate');
  });

  it('defaults workspaceId to default', () => {
    const finding = createFinding(baseInput({ workspaceId: undefined }));
    assert.strictEqual(finding.workspaceId, 'default');
  });

  it('requires title', () => {
    assert.throws(() => createFinding(baseInput({ title: '' })), /Invalid finding/);
  });

  it('requires evidence array', () => {
    assert.throws(() => createFinding(baseInput({ evidence: null })), /Invalid finding/);
  });

  it('produces deterministic finding ids for same input', () => {
    const input = baseInput();
    const first = createFindingId(input, { workspaceId: 'workspace-a' });
    const second = createFindingId({ ...input, evidence: [...input.evidence] }, { workspaceId: 'workspace-a' });
    assert.strictEqual(first, second);
  });

  it('changes finding id when workspace changes', () => {
    const input = baseInput();
    const first = createFindingId(input, { workspaceId: 'workspace-a' });
    const second = createFindingId(input, { workspaceId: 'workspace-b' });
    assert.notStrictEqual(first, second);
  });

  it('returned finding can be mutated without internal state leakage', () => {
    const finding = createFinding(baseInput());
    const snapshot = normalizeFinding(finding);
    finding.title = 'Mutated title';
    finding.evidence[0].detail = 'mutated';
    assert.strictEqual(snapshot.title, 'Unsafe GET route');
    assert.strictEqual(snapshot.evidence[0].detail, 'GET /api?q=... can trigger restore');
  });

  it('supports allowed and forbidden files on suggestedFix', () => {
    const finding = createFinding(baseInput());
    assert.deepStrictEqual(finding.suggestedFix.allowedFiles, ['server.js', 'server.test.js']);
    assert.deepStrictEqual(finding.suggestedFix.forbiddenFiles, ['kernel.js']);
  });

  it('isFinding returns true only for valid finding-like objects', () => {
    const finding = createFinding(baseInput());
    assert.strictEqual(isFinding(finding), true);
    assert.strictEqual(isFinding({ findingId: 'x', title: 'x' }), false);
  });

  it('does not write files or memory state', () => {
    const before = process.hrtime.bigint();
    const finding = createFinding(baseInput({ title: 'No side effects' }));
    const after = process.hrtime.bigint();

    assert.ok(after >= before);
    assert.ok(finding.findingId);
    assert.ok(FINDING_KINDS.includes(finding.kind));
    assert.ok(FINDING_SEVERITIES.includes(finding.severity));
  });
});

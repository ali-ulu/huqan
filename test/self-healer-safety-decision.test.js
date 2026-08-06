'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SELF_HEALER_DECISIONS,
  SELF_HEALER_DECISION_REASONS,
  decideSelfHealerAction,
  isDocsOnly,
} = require('../lib/self-healer/safety-decision');

function finding(overrides = {}) {
  return {
    findingId: 'f_test',
    kind: 'bug',
    severity: 'medium',
    confidence: 0.7,
    title: 'test finding',
    summary: 'test finding',
    evidence: [{ type: 'file', ref: 'lib/x.js', detail: 'something' }],
    affectedFiles: ['lib/x.js'],
    suggestedTests: [],
    riskFlags: [],
    ...overrides,
  };
}

// ─── blocking risk flags ─────────────────────────────────────────────────────

test('destructive_action is blocked', () => {
  const d = decideSelfHealerAction(finding({ riskFlags: ['destructive_action'] }));
  assert.equal(d.decision, SELF_HEALER_DECISIONS.BLOCK);
  assert.equal(d.reason, SELF_HEALER_DECISION_REASONS.DESTRUCTIVE_ACTION_BLOCKED);
});

test('unknown_tool is blocked', () => {
  const d = decideSelfHealerAction(finding({ riskFlags: ['unknown_tool'] }));
  assert.equal(d.decision, SELF_HEALER_DECISIONS.BLOCK);
});

test('release_operation is blocked', () => {
  const d = decideSelfHealerAction(finding({ riskFlags: ['release_operation'] }));
  assert.equal(d.decision, SELF_HEALER_DECISIONS.BLOCK);
});

test('a blocking flag is never downgraded by an otherwise-proposable finding', () => {
  const d = decideSelfHealerAction(finding({
    kind: 'stale_docs',
    affectedFiles: ['docs/readme.md'],
    riskFlags: ['destructive_action'],
  }));
  assert.equal(d.decision, SELF_HEALER_DECISIONS.BLOCK, 'docs-only must not rescue a destructive finding');
});

test('blocked findings are not approvable and have no next steps', () => {
  const d = decideSelfHealerAction(finding({ riskFlags: ['unknown_tool'] }));
  assert.equal(d.requiresApproval, false, 'block is refused, not queued for a human');
  assert.deepEqual(d.allowedNextSteps, []);
});

// ─── quarantine ──────────────────────────────────────────────────────────────

test('explicit insufficient_evidence is quarantined', () => {
  const d = decideSelfHealerAction(finding({ riskFlags: ['insufficient_evidence'] }));
  assert.equal(d.decision, SELF_HEALER_DECISIONS.QUARANTINE);
  assert.equal(d.requiresApproval, true);
  assert.ok(d.allowedNextSteps.includes('isolate'));
});

// ─── minimum evidence rule ───────────────────────────────────────────────────

test('a finding with no evidence is observe-only, never a proposal', () => {
  const d = decideSelfHealerAction(finding({ evidence: [] }));
  assert.equal(d.decision, SELF_HEALER_DECISIONS.OBSERVE);
  assert.equal(d.reason, SELF_HEALER_DECISION_REASONS.NO_EVIDENCE_OBSERVE_ONLY);
  assert.equal(d.requiresApproval, false);
});

test('docs-only with no evidence is still observe-only', () => {
  const d = decideSelfHealerAction(finding({
    kind: 'stale_docs', affectedFiles: ['docs/x.md'], evidence: [],
  }));
  assert.equal(d.decision, SELF_HEALER_DECISIONS.OBSERVE);
});

test('a finding naming no affected surface is observe-only', () => {
  const d = decideSelfHealerAction(finding({ affectedFiles: [] }));
  assert.equal(d.decision, SELF_HEALER_DECISIONS.OBSERVE);
  assert.equal(d.reason, SELF_HEALER_DECISION_REASONS.NO_AFFECTED_SURFACE_OBSERVE_ONLY);
});

// ─── review risk flags ───────────────────────────────────────────────────────

for (const flag of ['memory_mutation', 'canonical_write', 'runtime_mutation', 'cross_workspace_risk', 'dependency_setup']) {
  test(`${flag} requires human review`, () => {
    const d = decideSelfHealerAction(finding({ riskFlags: [flag] }));
    assert.equal(d.decision, SELF_HEALER_DECISIONS.REQUIRE_REVIEW);
    assert.equal(d.requiresApproval, true);
    assert.deepEqual(d.allowedNextSteps, ['human_review']);
  });
}

test('a mutation flag outranks docs-only', () => {
  const d = decideSelfHealerAction(finding({
    kind: 'stale_docs',
    affectedFiles: ['docs/x.md'],
    riskFlags: ['canonical_write'],
  }));
  assert.equal(d.decision, SELF_HEALER_DECISIONS.REQUIRE_REVIEW);
});

// ─── propose: the single permissive path ─────────────────────────────────────

test('a docs-only stale_docs finding may be proposed', () => {
  const d = decideSelfHealerAction(finding({
    kind: 'stale_docs',
    affectedFiles: ['docs/roadmap.md', 'README.md'],
  }));
  assert.equal(d.decision, SELF_HEALER_DECISIONS.PROPOSE);
  assert.equal(d.reason, SELF_HEALER_DECISION_REASONS.DOCS_ONLY_PROPOSAL);
});

test('propose still requires approval and never allows auto-apply', () => {
  const d = decideSelfHealerAction(finding({ kind: 'stale_docs', affectedFiles: ['docs/x.md'] }));
  assert.equal(d.requiresApproval, true);
  assert.ok(d.allowedNextSteps.includes('manual_apply'));
  assert.ok(!d.allowedNextSteps.includes('auto_apply'));
  assert.ok(!d.allowedNextSteps.includes('auto_merge'));
});

test('stale_docs touching a source file is not docs-only', () => {
  const d = decideSelfHealerAction(finding({
    kind: 'stale_docs',
    affectedFiles: ['docs/x.md', 'lib/kernel.js'],
  }));
  assert.equal(d.decision, SELF_HEALER_DECISIONS.REQUIRE_REVIEW);
});

test('a non-docs kind touching only docs is not proposable', () => {
  const d = decideSelfHealerAction(finding({ kind: 'security', affectedFiles: ['docs/x.md'] }));
  assert.equal(d.decision, SELF_HEALER_DECISIONS.REQUIRE_REVIEW,
    'only stale_docs reaches propose; a security finding never does');
});

// ─── fail-closed default ─────────────────────────────────────────────────────

test('an unremarkable finding defaults to require_review, not propose', () => {
  const d = decideSelfHealerAction(finding());
  assert.equal(d.decision, SELF_HEALER_DECISIONS.REQUIRE_REVIEW);
  assert.equal(d.reason, SELF_HEALER_DECISION_REASONS.DEFAULT_REVIEW_REQUIRED);
});

test('an unrecognized risk flag does not create a permissive path', () => {
  const d = decideSelfHealerAction(finding({ riskFlags: ['some_unknown_future_flag'] }));
  assert.equal(d.decision, SELF_HEALER_DECISIONS.REQUIRE_REVIEW);
});

test('risk flags are matched case-insensitively', () => {
  const d = decideSelfHealerAction(finding({ riskFlags: ['DESTRUCTIVE_ACTION'] }));
  assert.equal(d.decision, SELF_HEALER_DECISIONS.BLOCK);
});

test('no decision level ever authorizes applying a change', () => {
  const cases = [
    finding({ riskFlags: ['destructive_action'] }),
    finding({ riskFlags: ['insufficient_evidence'] }),
    finding({ evidence: [] }),
    finding({ riskFlags: ['runtime_mutation'] }),
    finding({ kind: 'stale_docs', affectedFiles: ['docs/x.md'] }),
    finding(),
  ];
  for (const input of cases) {
    const d = decideSelfHealerAction(input);
    for (const step of d.allowedNextSteps) {
      assert.ok(!/^auto_/.test(step), `decision ${d.decision} leaked an automatic step: ${step}`);
    }
  }
});

test('decideSelfHealerAction rejects a non-object finding', () => {
  assert.throws(() => decideSelfHealerAction(null), TypeError);
  assert.throws(() => decideSelfHealerAction('finding'), TypeError);
});

// ─── isDocsOnly ──────────────────────────────────────────────────────────────

test('isDocsOnly treats an empty file list as not docs-only', () => {
  assert.equal(isDocsOnly([]), false, 'affecting nothing must not earn the permissive path');
});

test('isDocsOnly recognizes doc paths and doc extensions', () => {
  assert.equal(isDocsOnly(['docs/a.md', 'doc/b.txt', 'NOTES.md']), true);
  assert.equal(isDocsOnly(['lib/a.js']), false);
  assert.equal(isDocsOnly(['docs/a.md', 'lib/a.js']), false);
});

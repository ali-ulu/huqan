'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SELF_HEALER_DRYRUN_MODE,
  runSelfHealerDryRun,
} = require('../lib/self-healer/dryrun-runner');

function docsFinding(overrides = {}) {
  return {
    kind: 'stale_docs',
    title: 'Roadmap drift',
    summary: 'roadmap claims a shipped feature',
    severity: 'info',
    evidence: [{ type: 'file', ref: 'docs/roadmap.md', detail: 'claims shipped' }],
    affectedFiles: ['docs/roadmap.md'],
    suggestedTests: [],
    ...overrides,
  };
}

function securityFinding(overrides = {}) {
  return {
    kind: 'security',
    title: 'Route lacks a gate',
    summary: 'mutating route has no gate',
    severity: 'high',
    evidence: [{ type: 'route', ref: 'server.js', detail: 'no gate' }],
    affectedFiles: ['server.js'],
    riskFlags: ['runtime_mutation'],
    ...overrides,
  };
}

// ─── the hard invariant: nothing is ever applied ─────────────────────────────

test('applied is false on the run and on every proposal', () => {
  const r = runSelfHealerDryRun({ findings: [docsFinding(), securityFinding()] });
  assert.equal(r.applied, false);
  assert.equal(r.mode, SELF_HEALER_DRYRUN_MODE);
  for (const p of r.proposals) {
    assert.equal(p.applied, false, `${p.kind} proposal must not be applied`);
  }
});

test('the run result and its proposals are frozen', () => {
  const r = runSelfHealerDryRun({ findings: [docsFinding()] });
  assert.ok(Object.isFrozen(r));
  assert.ok(Object.isFrozen(r.proposals));
  assert.ok(Object.isFrozen(r.proposals[0]));
  assert.ok(Object.isFrozen(r.summary));
});

test('no proposal ever requests an allow verdict', () => {
  const r = runSelfHealerDryRun({ findings: [docsFinding(), securityFinding()] });
  for (const p of r.proposals) {
    if (!p.approvalRequest) continue;
    assert.notEqual(p.approvalRequest.requestedVerdict, 'allow',
      'a self-proposed change must not describe itself as pre-authorized');
    assert.notEqual(p.approvalRequest.requestedVerdict, 'dry_run_only');
  }
});

// ─── AB10 budget is the runaway-loop stop ────────────────────────────────────

test('an exhausted loop budget blocks the run and emits no proposals', () => {
  const r = runSelfHealerDryRun(
    { findings: [docsFinding(), securityFinding()], iterationsUsed: 500 },
    { maxIterationsPerWindow: 2 },
  );
  assert.equal(r.blockedByBudget, true);
  assert.equal(r.budget.decision, 'block');
  assert.deepEqual(r.proposals, []);
  assert.equal(r.summary.approvalsRequired, 0);
  assert.equal(r.applied, false);
});

test('an omitted usage figure is reported, not silently treated as a fresh budget', () => {
  const r = runSelfHealerDryRun({ findings: [docsFinding()] });
  assert.equal(r.budgetUsageKnown, false,
    'a missing measurement must be distinguishable from genuinely-zero usage');
});

test('values that coerce to zero do not count as a known usage figure', () => {
  for (const iterationsUsed of [null, undefined, '', 'lots', NaN]) {
    const r = runSelfHealerDryRun({ findings: [docsFinding()], iterationsUsed });
    assert.equal(r.budgetUsageKnown, false, `${String(iterationsUsed)} must not read as measured usage`);
  }
});

test('a supplied usage figure, including a real zero, is reported as known', () => {
  for (const iterationsUsed of [0, 12, '7']) {
    const r = runSelfHealerDryRun({ findings: [docsFinding()], iterationsUsed });
    assert.equal(r.budgetUsageKnown, true, `${String(iterationsUsed)} is a real measurement`);
  }
});

test('a budget-blocked run still reports whether usage was known', () => {
  const r = runSelfHealerDryRun(
    { findings: [docsFinding()], iterationsUsed: 500 },
    { maxIterationsPerWindow: 2 },
  );
  assert.equal(r.blockedByBudget, true);
  assert.equal(r.budgetUsageKnown, true);
});

test('a run within budget proceeds and reports the budget decision', () => {
  const r = runSelfHealerDryRun({ findings: [docsFinding()], iterationsUsed: 0 });
  assert.equal(r.blockedByBudget, false);
  assert.equal(r.budget.decision, 'allow');
  assert.equal(r.proposals.length, 1);
});

// ─── decisions flow through from the safety matrix ───────────────────────────

test('decisions and approval requests match the safety decision', () => {
  const r = runSelfHealerDryRun({
    findings: [
      docsFinding(),
      securityFinding(),
      docsFinding({ evidence: [], affectedFiles: [] }),
      securityFinding({ riskFlags: ['release_operation'] }),
    ],
  });

  const byDecision = Object.fromEntries(r.proposals.map((p) => [p.decision, p]));

  assert.ok(byDecision.propose.approvalRequest, 'propose must produce an approval request');
  assert.ok(byDecision.require_review.approvalRequest, 'require_review must produce an approval request');
  assert.equal(byDecision.observe.approvalRequest, null, 'observe authorizes nothing, so needs no approval');
  assert.equal(byDecision.block.approvalRequest, null, 'block is refused, not queued');

  assert.equal(r.summary.propose, 1);
  assert.equal(r.summary.require_review, 1);
  assert.equal(r.summary.observe, 1);
  assert.equal(r.summary.block, 1);
  assert.equal(r.summary.approvalsRequired, 2);
});

test('approval requests are schema-valid (no build errors)', () => {
  const r = runSelfHealerDryRun({ findings: [docsFinding(), securityFinding()] });
  for (const p of r.proposals) {
    assert.equal(p.approvalErrors, null, `approval build failed: ${JSON.stringify(p.approvalErrors)}`);
  }
});

// ─── the approval payload carries no code ────────────────────────────────────

test('the approval payload declares no patch and includes none', () => {
  const r = runSelfHealerDryRun({ findings: [docsFinding()] });
  const payload = r.proposals[0].approvalRequest.actionPayload;
  assert.equal(payload.patchIncluded, false);
  assert.equal(payload.applied, false);
  assert.ok(!('patch' in payload));
  assert.ok(!('diff' in payload));
  assert.ok(!('content' in payload));
});

test('caller-supplied patch-like fields never reach the result', () => {
  const r = runSelfHealerDryRun({
    findings: [docsFinding({
      patch: 'rm -rf / # attacker supplied',
      diff: '--- a/kernel.js +++ b/kernel.js',
      suggestedFix: { summary: 'update the roadmap wording', patch: 'malicious()' },
    })],
  });
  const serialized = JSON.stringify(r);
  assert.equal(serialized.includes('attacker supplied'), false);
  assert.equal(serialized.includes('malicious()'), false);
  assert.equal(serialized.includes('--- a/kernel.js'), false);
  // the legitimate, non-code part of suggestedFix still survives
  assert.equal(r.proposals[0].approvalRequest.actionPayload.suggestedFixSummary,
    'update the roadmap wording');
});

// ─── receipt summary ─────────────────────────────────────────────────────────

test('every proposal carries a receipt summary that records the decision', () => {
  const r = runSelfHealerDryRun({ findings: [securityFinding()] });
  const receipt = r.proposals[0].receiptSummary;
  assert.match(receipt.receiptId, /^shr_[0-9a-f]{16}$/);
  assert.equal(receipt.receiptKind, 'self_healer_dryrun_summary');
  assert.equal(receipt.decision, 'require_review');
  assert.equal(receipt.approvalRequired, true);
  assert.equal(receipt.scopeSummary.applied, false);
  assert.equal(receipt.scopeSummary.mode, SELF_HEALER_DRYRUN_MODE);
  assert.equal(receipt.evidenceSummary.evidenceCount, 1);
  assert.equal(receipt.riskSummary.severity, 'high');
});

test('a blocked finding still gets a receipt summary explaining the refusal', () => {
  const r = runSelfHealerDryRun({ findings: [securityFinding({ riskFlags: ['destructive_action'] })] });
  const receipt = r.proposals[0].receiptSummary;
  assert.equal(receipt.decision, 'block');
  assert.equal(receipt.reason, 'destructive_action_blocked');
  assert.equal(receipt.approvalRequired, false);
});

// ─── determinism and edges ───────────────────────────────────────────────────

test('the same findings produce the same runId and receipt ids', () => {
  const findings = [docsFinding(), securityFinding()];
  const a = runSelfHealerDryRun({ findings, workspaceId: 'ws1' });
  const b = runSelfHealerDryRun({ findings, workspaceId: 'ws1' });
  assert.equal(a.runId, b.runId);
  assert.deepEqual(
    a.proposals.map((p) => p.receiptSummary.receiptId),
    b.proposals.map((p) => p.receiptSummary.receiptId),
  );
});

test('a different workspace produces a different runId', () => {
  const findings = [docsFinding()];
  const a = runSelfHealerDryRun({ findings, workspaceId: 'ws1' });
  const b = runSelfHealerDryRun({ findings, workspaceId: 'ws2' });
  assert.notEqual(a.runId, b.runId);
});

test('proposals stay scoped to the run workspace', () => {
  const r = runSelfHealerDryRun({ findings: [docsFinding()], workspaceId: 'ws-alpha' });
  assert.equal(r.workspaceId, 'ws-alpha');
  assert.equal(r.proposals[0].approvalRequest.workspaceId, 'ws-alpha');
  assert.equal(r.proposals[0].receiptSummary.scopeSummary.workspaceId, 'ws-alpha');
});

test('an empty finding set is a valid, empty run', () => {
  const r = runSelfHealerDryRun({ findings: [] });
  assert.equal(r.ok, true);
  assert.equal(r.findingCount, 0);
  assert.deepEqual(r.proposals, []);
  assert.equal(r.summary.approvalsRequired, 0);
  assert.equal(r.applied, false);
});

test('missing or malformed input does not throw and applies nothing', () => {
  for (const input of [undefined, null, {}, 'nope', { findings: 'not-an-array' }]) {
    const r = runSelfHealerDryRun(input);
    assert.equal(r.ok, true);
    assert.equal(r.applied, false);
    assert.deepEqual(r.proposals, []);
  }
});

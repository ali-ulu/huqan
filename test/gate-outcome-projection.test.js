'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  AGENT_IDENTITY_CARD_SCHEMA_VERSION,
} = require('../lib/external-action-identity');
const {
  evaluateExternalAction,
  recordExternalActionOutcome,
} = require('../lib/external-action-guard');
const {
  createInitialState,
  startFromDreamResult,
} = require('../lib/dream-experiment-loop');
const { processDreamStep } = require('../lib/agent-v3-dream-loop-adapter');
const {
  MAX_CITATIONS,
  PROJECTION_VERSION,
  gateOutcomeCitations,
  projectGateOutcomeTrail,
} = require('../lib/gate-outcome-projection');

const NOW = '2026-01-01T12:00:00.000Z';
const ISSUED_AT = '2026-01-01T00:00:00.000Z';
const EXPIRES_AT = '2026-01-02T00:00:00.000Z';
const AGENT = 'gate-trail-agent';
const WORKSPACE = 'ws-gate';

function mkTmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-gate-projection-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function agentCard(overrides = {}) {
  return {
    schemaVersion: AGENT_IDENTITY_CARD_SCHEMA_VERSION,
    agentId: AGENT,
    agentName: AGENT,
    agentVersion: '1.0.0',
    ownerActorId: 'actor:ali',
    workspaceId: WORKSPACE,
    capabilities: ['file_write', 'shell'],
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

function actionEnvelope({ dir, invocationId, toolName, args, workspaceId = WORKSPACE, card }) {
  return {
    invocationId,
    agentName: AGENT,
    sessionId: 'session-gate',
    turnId: 'turn-gate',
    toolName,
    args,
    cwd: dir,
    workspaceRoot: dir,
    workspaceId,
    identity: card || agentCard({ workspaceId }),
  };
}

function admit(envelope, receipts) {
  return evaluateExternalAction(envelope, {
    now: () => NOW,
    receiptWriter: { append: receipt => receipts.push(receipt) },
    requireSignedIdentityCard: false,
  });
}

function assertAdmitted(decision) {
  assert.ok(['allow', 'review'].includes(decision), `expected an admitted decision, got "${decision}"`);
}

// A write whose effect is independently observed between admission and outcome:
// the only path that may reach canonical evidence.
function observedFileWrite(dir, { invocationId = 'inv-observed', workspaceId = WORKSPACE } = {}) {
  const receipts = [];
  const target = path.join(dir, `${invocationId}.txt`);
  const envelope = actionEnvelope({
    dir,
    invocationId,
    toolName: 'Write',
    args: { file_path: target, content: 'gate outcome learning\n' },
    workspaceId,
  });
  const admission = admit(envelope, receipts);
  fs.writeFileSync(target, 'gate outcome learning\n');
  const outcome = recordExternalActionOutcome(envelope, admission.receipt, { status: 'success', output: 'ok' });
  receipts.push(outcome.receipt);
  return { receipts, admission, outcome };
}

// A shell action with a successful outcome but no observable side effect.
function reportedShell(dir, { invocationId = 'inv-reported', workspaceId = WORKSPACE } = {}) {
  const receipts = [];
  const envelope = actionEnvelope({
    dir,
    invocationId,
    toolName: 'Bash',
    args: { command: 'echo hello' },
    workspaceId,
  });
  const admission = admit(envelope, receipts);
  const outcome = recordExternalActionOutcome(envelope, admission.receipt, { status: 'success', output: 'hello\n' });
  receipts.push(outcome.receipt);
  return { receipts, admission, outcome };
}

function pendingAdmission(dir, { invocationId = 'inv-pending', workspaceId = WORKSPACE } = {}) {
  const receipts = [];
  const envelope = actionEnvelope({
    dir,
    invocationId,
    toolName: 'Write',
    args: { file_path: path.join(dir, `${invocationId}.txt`), content: 'never executed\n' },
    workspaceId,
  });
  const admission = admit(envelope, receipts);
  return { receipts, admission };
}

function failedOutcome(dir, { invocationId = 'inv-failed', workspaceId = WORKSPACE } = {}) {
  const receipts = [];
  const envelope = actionEnvelope({
    dir,
    invocationId,
    toolName: 'Bash',
    args: { command: 'echo hello' },
    workspaceId,
  });
  const admission = admit(envelope, receipts);
  const outcome = recordExternalActionOutcome(envelope, admission.receipt, { status: 'error', output: 'boom' });
  receipts.push(outcome.receipt);
  return { receipts, admission, outcome };
}

function writeTrail(trailPath, receipts) {
  fs.writeFileSync(
    trailPath,
    `${receipts.map(receipt => JSON.stringify(receipt)).join('\n')}\n`,
    'utf8',
  );
}

function fakeKernel() {
  const journal = new Map();
  const audits = [];
  return {
    graph: {
      runMutationOnce(operationId, mutate) {
        if (journal.has(operationId)) return { replayed: true, result: journal.get(operationId) };
        const result = mutate();
        journal.set(operationId, result);
        return { replayed: false, result, persisted: true };
      },
      appendAuditEvent(event) {
        const normalized = { auditId: `audit-${audits.length + 1}`, ...event };
        audits.push(normalized);
        return normalized;
      },
    },
    _test: { audits },
  };
}

const loopContext = { workspaceId: WORKSPACE, goal: 'learn gate outcomes', maxHypotheses: 2, maxCycles: 1 };
const dreams = [{ from: 'kedi', to: 'hayvan', relation: 'tür', confidence: 0.9 }];

test('an admitted and observed outcome reaches canonical evidence (rank 30)', (t) => {
  const dir = mkTmp(t);
  const fixture = observedFileWrite(dir);
  assertAdmitted(fixture.admission.decision);

  const projection = projectGateOutcomeTrail(fixture.receipts, { workspaceId: WORKSPACE });

  assert.equal(projection.projectionVersion, PROJECTION_VERSION);
  assert.equal(projection.claims.length, 1);
  assert.equal(projection.pending.length, 0);
  assert.equal(projection.skipped.length, 0);

  const claim = projection.claims[0];
  assert.equal(claim.claimKey, `${WORKSPACE}::Write`);
  assert.equal(claim.workspaceId, WORKSPACE);
  assert.equal(claim.toolName, 'Write');
  assert.equal(claim.level, 'canonical_evidence');
  assert.equal(claim.ladder.currentRank, 30);
  assert.equal(claim.approved, 1);
  assert.equal(claim.refused, 0);
  assert.equal(claim.citations.length, 1);

  const citation = claim.citations[0];
  assert.equal(citation.receiptId, fixture.outcome.receipt.receiptId);
  assert.equal(citation.admissionReceiptId, fixture.admission.receipt.receiptId);
  assert.equal(citation.observed, true);
  assert.equal(citation.admitted, true);
  assert.equal(citation.effectVerification, 'observed');
  assert.equal(citation.verdict, 'approved');
  assert.equal(citation.outcome, 'executed');
  assert.equal(citation.level, 'canonical_evidence');
});

test('a Dream hypothesis can cite a real observed outcome receipt', (t) => {
  const dir = mkTmp(t);
  const trailPath = path.join(dir, 'trail.jsonl');
  const fixture = observedFileWrite(dir);
  writeTrail(trailPath, fixture.receipts);

  const citations = gateOutcomeCitations(WORKSPACE, { path: trailPath });
  assert.equal(citations.length, 1);
  assert.equal(citations[0].receiptId, fixture.outcome.receipt.receiptId);

  const kernel = fakeKernel();
  const result = startFromDreamResult(kernel, createInitialState(loopContext), dreams, {
    ...loopContext,
    gateEvidence: citations,
  });

  assert.equal(result.state.hypotheses.length, 1);
  const hypothesis = result.state.hypotheses[0];
  assert.ok(Array.isArray(hypothesis.gateEvidence));
  assert.equal(hypothesis.gateEvidence.length, 1);
  assert.equal(hypothesis.gateEvidence[0].receiptId, fixture.outcome.receipt.receiptId);
  assert.equal(hypothesis.gateEvidence[0].level, 'canonical_evidence');
});

test('processDreamStep threads gate citations into generated hypotheses', (t) => {
  const dir = mkTmp(t);
  const trailPath = path.join(dir, 'trail.jsonl');
  const fixture = observedFileWrite(dir);
  writeTrail(trailPath, fixture.receipts);

  const result = processDreamStep(
    fakeKernel(),
    {},
    { step: { tool: 'dream' }, report: { result: dreams } },
    { ...loopContext, gateReceiptPath: trailPath },
  );

  assert.equal(result.handled, true);
  assert.equal(result.blocked, false);
  const hypothesis = result.state.hypotheses[0];
  assert.ok(Array.isArray(hypothesis.gateEvidence));
  assert.equal(hypothesis.gateEvidence.length, 1);
  assert.equal(hypothesis.gateEvidence[0].receiptId, fixture.outcome.receipt.receiptId);
});

test('an admission with no outcome is silence, never evidence', (t) => {
  const dir = mkTmp(t);
  const trailPath = path.join(dir, 'trail.jsonl');
  const fixture = pendingAdmission(dir);
  assertAdmitted(fixture.admission.decision);
  writeTrail(trailPath, fixture.receipts);

  const projection = projectGateOutcomeTrail(fixture.receipts, { workspaceId: WORKSPACE });
  assert.equal(projection.claims.length, 0);
  assert.equal(projection.pending.length, 1);
  assert.match(projection.pending[0].why, /silence is not evidence/);
  assert.equal(gateOutcomeCitations(WORKSPACE, { path: trailPath }).length, 0);
});

test('an outcome without a verdict stays pending', (t) => {
  const dir = mkTmp(t);
  const trailPath = path.join(dir, 'trail.jsonl');
  const fixture = failedOutcome(dir);
  assert.equal(fixture.outcome.receipt.status, 'failed');
  writeTrail(trailPath, fixture.receipts);

  const projection = projectGateOutcomeTrail(fixture.receipts, { workspaceId: WORKSPACE });
  assert.equal(projection.claims.length, 0);
  assert.equal(projection.pending.length, 1);
  assert.match(projection.pending[0].why, /no verdict/);
  assert.equal(gateOutcomeCitations(WORKSPACE, { path: trailPath }).length, 0);
});

test('reported effects stay review candidates', (t) => {
  const dir = mkTmp(t);
  const fixture = reportedShell(dir);
  assertAdmitted(fixture.admission.decision);

  const projection = projectGateOutcomeTrail(fixture.receipts, { workspaceId: WORKSPACE });
  assert.equal(projection.claims.length, 1);

  const claim = projection.claims[0];
  assert.equal(claim.level, 'review_candidate');
  assert.equal(claim.ladder.currentRank, 20);
  assert.equal(claim.approved, 1);

  const citation = claim.citations[0];
  assert.equal(citation.observed, false);
  assert.equal(citation.effectVerification, 'reported');
  assert.equal(citation.admitted, true);
  assert.equal(citation.verdict, 'approved');
});

test('a tampered receipt is skipped, never laundered into a claim', (t) => {
  const dir = mkTmp(t);
  const fixture = observedFileWrite(dir);
  const tampered = fixture.receipts.map(receipt => JSON.parse(JSON.stringify(receipt)));
  // The outcome claims an observed effect it no longer hashes to; the stale
  // hash keeps the tamper detectable.
  tampered[1].metadata.effectVerification = 'reported';

  const projection = projectGateOutcomeTrail(tampered, { workspaceId: WORKSPACE });
  assert.equal(projection.claims.length, 0);
  assert.equal(projection.skipped.length, 1);
  assert.match(projection.skipped[0].why, /hash does not verify/);
  // The pair is reported through `skipped`, so its admission is not also
  // misreported as silent.
  assert.equal(projection.pending.length, 0);
});

test('the projection and citations are workspace-scoped', (t) => {
  const dir = mkTmp(t);
  const trailPath = path.join(dir, 'trail.jsonl');
  const gate = observedFileWrite(dir, { invocationId: 'inv-ws-gate' });
  const other = observedFileWrite(dir, {
    invocationId: 'inv-ws-other',
    workspaceId: 'ws-other',
  });
  const combined = [...gate.receipts, ...other.receipts];
  writeTrail(trailPath, combined);

  const unscoped = projectGateOutcomeTrail(combined);
  assert.equal(unscoped.claims.length, 2);

  const scoped = projectGateOutcomeTrail(combined, { workspaceId: WORKSPACE });
  assert.equal(scoped.claims.length, 1);
  assert.equal(scoped.claims[0].workspaceId, WORKSPACE);
  assert.equal(scoped.receiptCount, combined.length);

  const otherCitations = gateOutcomeCitations('ws-other', { path: trailPath });
  assert.equal(otherCitations.length, 1);
  assert.equal(otherCitations[0].receiptId, other.outcome.receipt.receiptId);
  assert.equal(otherCitations[0].workspaceId, 'ws-other');
});

test('citations are capped at the most recent eight', (t) => {
  const dir = mkTmp(t);
  const trailPath = path.join(dir, 'trail.jsonl');
  const receipts = [];
  let lastOutcomeId = '';
  for (let index = 0; index < 10; index += 1) {
    const fixture = observedFileWrite(dir, { invocationId: `inv-cap-${index}` });
    receipts.push(...fixture.receipts);
    lastOutcomeId = fixture.outcome.receipt.receiptId;
  }
  writeTrail(trailPath, receipts);

  const projection = projectGateOutcomeTrail(receipts, { workspaceId: WORKSPACE });
  assert.equal(projection.claims.length, 1);
  assert.equal(projection.claims[0].citations.length, MAX_CITATIONS);
  assert.equal(projection.claims[0].citations[MAX_CITATIONS - 1].receiptId, lastOutcomeId);
  // The tallies keep counting what the citation list no longer shows.
  assert.equal(projection.claims[0].approved, 10);

  const citations = gateOutcomeCitations(WORKSPACE, { path: trailPath });
  assert.equal(citations.length, MAX_CITATIONS);
  assert.equal(citations[citations.length - 1].receiptId, lastOutcomeId);
});

test('an unavailable trail contributes no evidence and leaves hypotheses unchanged', (t) => {
  const dir = mkTmp(t);
  assert.deepEqual(gateOutcomeCitations(WORKSPACE, { path: path.join(dir, 'absent.jsonl') }), []);

  const withoutEvidence = startFromDreamResult(
    fakeKernel(),
    createInitialState(loopContext),
    dreams,
    loopContext,
  );
  assert.equal('gateEvidence' in withoutEvidence.state.hypotheses[0], false);

  const withEmptyEvidence = startFromDreamResult(
    fakeKernel(),
    createInitialState(loopContext),
    dreams,
    { ...loopContext, gateEvidence: [] },
  );
  assert.equal('gateEvidence' in withEmptyEvidence.state.hypotheses[0], false);
});

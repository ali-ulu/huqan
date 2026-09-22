'use strict';

// A session's cumulative blast radius on the external action receipt,
// summarized from the receipt history the guard already reads (#2505).
// Recorded only: the owner decided that no threshold is enforced until it has
// been calibrated against these records.

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildCanonicalReceiptPayload, hashCanonicalReceiptPayload } = require('../lib/receipt/canonical-receipt');
const { fromMcpDecision } = require('../lib/verdict/action-verdict');
const { MAX_HISTORY_RECEIPTS, readReceiptHistory } = require('../lib/autonomy-receipt-history');
const { evaluateExternalAction } = require('../lib/external-action-guard');
const { summarizeSessionImpact } = require('../lib/session-impact');

let sequence = 0;

function sealed({
  sessionId,
  score,
  kind = 'external_action_admission_receipt',
  toolName,
  inputDigest,
} = {}) {
  sequence += 1;
  const metadata = { sessionId };
  if (score !== undefined) metadata.justification = { blastRadius: { score } };
  if (toolName !== undefined) metadata.toolName = toolName;
  if (inputDigest !== undefined) metadata.inputDigest = inputDigest;
  const receipt = {
    receiptId: `adm-budget-${sequence}`,
    receiptKind: kind,
    decision: 'allow',
    status: kind === 'external_action_outcome_receipt' ? 'executed' : 'admitted',
    admissionId: `budget-${sequence}`,
    workspaceId: 'default',
    actor: 'budget-agent',
    agentId: 'budget-agent',
    memoryDraftId: 'not_applicable',
    provenanceId: 'external:budget-agent:history',
    trustPolicyVersion: 'huqan-external-action-guard-v1',
    approvalId: 'not_applicable',
    approvalStatus: 'not_required',
    reason: 'history',
    riskScore: 0,
    createdAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + sequence * 1000).toISOString(),
    metadata,
  };
  const canonical = buildCanonicalReceiptPayload(receipt, { verdict: fromMcpDecision({ decision: 'allow', reason: 'history' }).verdict });
  return { ...canonical, receiptHash: hashCanonicalReceiptPayload(canonical) };
}

function cut(receipts) {
  Object.defineProperty(receipts, 'truncated', { value: true });
  return receipts;
}

test("only this session's verified admission receipts are summed", () => {
  const summary = summarizeSessionImpact([
    sealed({ sessionId: 's1', score: 40 }),
    sealed({ sessionId: 's2', score: 90 }),
    sealed({ sessionId: 's1', score: 60 }),
    sealed({ sessionId: 's1', score: 70, kind: 'external_action_outcome_receipt' }),
  ], 's1');
  assert.equal(summary.priorActions, 2);
  assert.equal(summary.scoredActions, 2);
  assert.equal(summary.unscoredActions, 0);
  assert.equal(summary.recordedScoreTotal, 100);
  assert.equal(summary.maxScore, 60);
  assert.equal(summary.status, 'computed');
  assert.deepEqual(summary.reasons, []);
});

test('a receipt without a blast radius score is unscored, never 0', () => {
  const summary = summarizeSessionImpact([sealed({ sessionId: 's1', score: 40 }), sealed({ sessionId: 's1' })], 's1');
  assert.equal(summary.scoredActions, 1);
  assert.equal(summary.unscoredActions, 1);
  assert.equal(summary.recordedScoreTotal, 40);
  assert.equal(summary.status, 'partial');
  assert.match(summary.reasons[0], /^1 earlier action\(s\) in the session carry no blast radius score$/);
});

test('a receipt that fails hash verification is not counted, and the summary says so', () => {
  const genuine = sealed({ sessionId: 's1', score: 50 });
  const tampered = { ...genuine, metadata: { ...genuine.metadata, justification: { blastRadius: { score: 1 } } } };
  const summary = summarizeSessionImpact([tampered], 's1');
  assert.equal(summary.priorActions, 0);
  assert.equal(summary.recordedScoreTotal, 0);
  assert.equal(summary.status, 'partial');
  assert.match(summary.reasons.join('\n'), /1 receipt\(s\) in the session failed hash verification/);
});

test('a history window cut inside this session is partial; one cut before it is not', () => {
  const inside = summarizeSessionImpact(cut([sealed({ sessionId: 's1', score: 10 }), sealed({ sessionId: 's2', score: 20 })]), 's1');
  assert.equal(inside.status, 'partial');
  assert.match(inside.reasons.join('\n'), /history window was cut and begins inside this session/);

  const before = summarizeSessionImpact(cut([sealed({ sessionId: 's2', score: 20 }), sealed({ sessionId: 's1', score: 10 })]), 's1');
  assert.equal(before.status, 'computed');
});

test('without a session or a history there is nothing to sum: unknown, not 0', () => {
  const noSession = summarizeSessionImpact([sealed({ sessionId: 's1', score: 40 })], '');
  assert.equal(noSession.status, 'unknown');
  assert.equal(noSession.recordedScoreTotal, null);
  const noHistory = summarizeSessionImpact(undefined, 's1');
  assert.equal(noHistory.status, 'unknown');
  assert.match(noHistory.reasons[0], /history was not read/);
});

test('readReceiptHistory marks a history it had to cut, without an enumerable field', () => {
  const long = readReceiptHistory({ receipts: Array.from({ length: MAX_HISTORY_RECEIPTS + 1 }, () => ({})) });
  assert.equal(long.length, MAX_HISTORY_RECEIPTS);
  assert.equal(long.truncated, true);
  assert.equal(Object.keys(long).includes('truncated'), false);
  assert.equal(readReceiptHistory({ receipts: [{}] }).truncated, false);
  const fs = require('node:fs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-receipt-missing-'));
  try {
    const missing = readReceiptHistory({ path: path.join(root, 'missing.jsonl') });
    assert.deepEqual(missing, []);
    assert.equal(missing.truncated, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function guard(receipts, extraOptions = {}) {
  sequence += 1;
  return evaluateExternalAction({
    invocationId: `budget-guard-${sequence}`,
    agentName: 'budget-agent',
    sessionId: 'budget-session',
    turnId: 'turn-1',
    toolName: 'Read',
    action: 'read',
    args: { file_path: 'README.md' },
    cwd: process.cwd(),
    workspaceRoot: process.cwd(),
    workspaceId: 'default',
  }, {
    environment: {},
    dataResidency: null,
    receiptWriter: { append() {} },
    graduatedAutonomy: { enabled: true, receipts },
    ...extraOptions,
  });
}

test('the receipt records the session total including this action, and it moves no decision', () => {
  const withHistory = guard([
    sealed({ sessionId: 'budget-session', score: 40 }),
    sealed({ sessionId: 'other-session', score: 90 }),
    sealed({ sessionId: 'budget-session', score: 60 }),
  ]);
  const withoutSessionHistory = guard([sealed({ sessionId: 'other-session', score: 90 })]);
  const { blastRadius, cumulative } = withHistory.receipt.metadata.justification;
  assert.equal(cumulative.sessionId, 'budget-session');
  assert.equal(cumulative.priorActions, 2);
  assert.equal(cumulative.actions, 3);
  assert.equal(cumulative.recordedScoreTotal, 100 + blastRadius.score);
  assert.equal(cumulative.maxScore, Math.max(60, blastRadius.score));
  assert.equal(cumulative.status, 'computed');
  assert.equal(cumulative.enforced, false);
  assert.equal(withHistory.decision, withoutSessionHistory.decision);
  assert.equal(withHistory.reason, withoutSessionHistory.reason);
  assert.equal(withoutSessionHistory.receipt.metadata.justification.cumulative.priorActions, 0);
});

test('with graduated autonomy disabled the history is not read, and the session total is unknown', () => {
  const result = guard(undefined, { graduatedAutonomy: { enabled: false } });
  const { cumulative } = result.receipt.metadata.justification;
  assert.equal(cumulative.status, 'unknown');
  assert.match(cumulative.reasons[0], /history was not read/);
  assert.equal(cumulative.enforced, false);
});

test('an earlier unscored action makes the session total partial, with the reason carried onto the receipt', () => {
  const result = guard([sealed({ sessionId: 'budget-session', score: 40 }), sealed({ sessionId: 'budget-session' })]);
  const { cumulative } = result.receipt.metadata.justification;
  assert.equal(cumulative.status, 'partial');
  assert.match(cumulative.reasons.join('\n'), /1 earlier action\(s\) in the session carry no blast radius score/);
});

test('an action with no session has no session total: unknown and null, not a number', () => {
  const result = evaluateExternalAction({
    invocationId: 'budget-no-session',
    agentName: 'budget-agent',
    toolName: 'Read',
    action: 'read',
    args: { file_path: 'README.md' },
    cwd: process.cwd(),
    workspaceRoot: process.cwd(),
    workspaceId: 'default',
  }, {
    environment: {},
    dataResidency: null,
    receiptWriter: { append() {} },
    graduatedAutonomy: { enabled: true, receipts: [sealed({ sessionId: 'budget-session', score: 40 })] },
  });
  const { cumulative } = result.receipt.metadata.justification;
  assert.equal(cumulative.status, 'unknown');
  assert.equal(cumulative.recordedScoreTotal, null);
  assert.match(cumulative.reasons[0], /names no session/);
});

test("the session maximum includes this action's own score", () => {
  const result = guard([sealed({ sessionId: 'budget-session', score: 5 })]);
  const { blastRadius, cumulative } = result.receipt.metadata.justification;
  assert.ok(blastRadius.score > 5, 'the fixture needs this action to score above the history');
  assert.equal(cumulative.maxScore, blastRadius.score);
});

test('recorded sandbox escapes are counted per session without moving the score total', () => {
  const escapes = [
    { operationId: 'sandbox-isolation:1', decision: 'block', reason: 'path-escape', workspaceId: 'default' },
    { operationId: 'sandbox-isolation:2', decision: 'quarantine', reason: 'network-egress', workspaceId: 'team-a' },
  ];
  const summary = summarizeSessionImpact([sealed({ sessionId: 's1', score: 40 })], 's1', { sandboxEscapes: escapes });
  assert.equal(summary.sandboxEscapeAttempts, 2);
  assert.equal(summary.recordedScoreTotal, 40);
  assert.equal(summary.scoredActions, 1);
  assert.equal(summary.status, 'partial');
  assert.match(summary.reasons.join('\n'), /2 sandbox escape attempt\(s\) recorded in workspace\(s\) default, team-a/);
});

test('without an escape stream the count is null (not read), never 0', () => {
  const summary = summarizeSessionImpact([sealed({ sessionId: 's1', score: 40 })], 's1');
  assert.equal(summary.sandboxEscapeAttempts, null);
  assert.deepEqual(summary.reasons, []);
});

test('an empty escape stream is a measured 0 and keeps a clean history computed', () => {
  const summary = summarizeSessionImpact([sealed({ sessionId: 's1', score: 40 })], 's1', { sandboxEscapes: [] });
  assert.equal(summary.sandboxEscapeAttempts, 0);
  assert.equal(summary.status, 'computed');
  assert.deepEqual(summary.reasons, []);
});

test('a malformed escape stream never breaks the summary', () => {
  const summary = summarizeSessionImpact([sealed({ sessionId: 's1', score: 40 })], 's1', { sandboxEscapes: 'nope' });
  assert.equal(summary.sandboxEscapeAttempts, null);
  assert.equal(summary.recordedScoreTotal, 40);
});

test('the guard carries caller-supplied escapes onto the receipt without moving the decision', () => {
  const escapes = [{ operationId: 'sandbox-isolation:9', decision: 'block', reason: 'path-escape', workspaceId: 'default' }];
  const withEscapes = guard([sealed({ sessionId: 'budget-session', score: 40 })], { sandboxEscapes: escapes });
  const withoutEscapes = guard([sealed({ sessionId: 'budget-session', score: 40 })]);
  const { cumulative } = withEscapes.receipt.metadata.justification;
  assert.equal(cumulative.sandboxEscapeAttempts, 1);
  assert.match(cumulative.reasons.join('\n'), /1 sandbox escape attempt\(s\) recorded/);
  assert.equal(withEscapes.decision, withoutEscapes.decision);
  assert.equal(withEscapes.reason, withoutEscapes.reason);
  assert.equal(withoutEscapes.receipt.metadata.justification.cumulative.sandboxEscapeAttempts, null);
});

test('rejection receipts in the session are counted as refused actions', () => {
  const summary = summarizeSessionImpact([
    sealed({ sessionId: 's1', score: 40 }),
    sealed({ sessionId: 's1', score: 30, kind: 'external_action_rejection_receipt' }),
    sealed({ sessionId: 's2', score: 90, kind: 'external_action_rejection_receipt' }),
  ], 's1');
  assert.equal(summary.refusedActions, 1);
  assert.equal(summary.recordedScoreTotal, 70);
  assert.equal(summary.status, 'partial');
  assert.match(summary.reasons.join('\n'), /1 refused action\(s\) in the session \(rejection receipts\)/);
});


test('repeated refusal of the same tool and input digest is recorded as a retry signal', () => {
  const digest = 'a'.repeat(64);
  const summary = summarizeSessionImpact([
    sealed({ sessionId: 's1', score: 40, kind: 'external_action_rejection_receipt', toolName: 'payment.execute', inputDigest: digest }),
    sealed({ sessionId: 's1', score: 30, kind: 'external_action_rejection_receipt', toolName: 'payment.execute', inputDigest: digest }),
    sealed({ sessionId: 's1', score: 20, kind: 'external_action_rejection_receipt', toolName: 'payment.execute', inputDigest: digest }),
  ], 's1');
  assert.equal(summary.refusedActions, 3);
  assert.equal(summary.retriedRefusedActions, 2);
  assert.match(summary.reasons.join('\n'), /2 retried refused action\(s\) matched an earlier tool and input digest/);
});

test('different inputs, different tools and legacy refusals are not guessed into retry count', () => {
  const summary = summarizeSessionImpact([
    sealed({ sessionId: 's1', score: 40, kind: 'external_action_rejection_receipt', toolName: 'payment.execute', inputDigest: 'a'.repeat(64) }),
    sealed({ sessionId: 's1', score: 30, kind: 'external_action_rejection_receipt', toolName: 'payment.execute', inputDigest: 'b'.repeat(64) }),
    sealed({ sessionId: 's1', score: 20, kind: 'external_action_rejection_receipt', toolName: 'other.tool', inputDigest: 'a'.repeat(64) }),
    sealed({ sessionId: 's1', score: 10, kind: 'external_action_rejection_receipt' }),
  ], 's1');
  assert.equal(summary.refusedActions, 4);
  assert.equal(summary.retriedRefusedActions, 0);
});

test('no history keeps retry count unknown instead of reporting a measured zero', () => {
  const summary = summarizeSessionImpact(undefined, 's1');
  assert.equal(summary.retriedRefusedActions, null);
});

test('review receipts are legitimate flow, not refusals; no history means no count', () => {
  const summary = summarizeSessionImpact([
    sealed({ sessionId: 's1', score: 40 }),
    sealed({ sessionId: 's1', score: 30, kind: 'external_action_review_receipt' }),
  ], 's1');
  assert.equal(summary.refusedActions, 0);
  assert.equal(summary.status, 'computed');
  const noHistory = summarizeSessionImpact(undefined, 's1');
  assert.equal(noHistory.refusedActions, null);
  assert.equal(noHistory.status, 'unknown');
});

test('the guard receipt carries the refusal count without moving the decision', () => {
  const result = guard([
    sealed({ sessionId: 'budget-session', score: 40 }),
    sealed({ sessionId: 'budget-session', score: 30, kind: 'external_action_rejection_receipt' }),
  ]);
  const plain = guard([sealed({ sessionId: 'budget-session', score: 40 })]);
  const { cumulative } = result.receipt.metadata.justification;
  assert.equal(cumulative.refusedActions, 1);
  assert.equal(result.decision, plain.decision);
  assert.equal(result.reason, plain.reason);
});

test('readReceiptHistory marks a receipt file it had to cut', () => {
  const fs = require('node:fs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-receipt-history-'));
  try {
    const long = path.join(root, 'long.jsonl');
    fs.writeFileSync(long, '{}\n'.repeat(MAX_HISTORY_RECEIPTS + 1));
    const cutHistory = readReceiptHistory({ path: long });
    assert.equal(cutHistory.length, MAX_HISTORY_RECEIPTS);
    assert.equal(cutHistory.truncated, true);

    const short = path.join(root, 'short.jsonl');
    fs.writeFileSync(short, '{}\n{}\n');
    assert.equal(readReceiptHistory({ path: short }).truncated, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

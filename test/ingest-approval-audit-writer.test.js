'use strict';

/**
 * Contract for P1's first routed caller.
 *
 * The point of routing the smallest call site first was to test the seam's API
 * against a production caller before the large families are moved onto it. So
 * these tests are about the three things that routing had to prove:
 *
 *   1. the mutation is unreachable when admission refuses;
 *   2. the audit write that does happen is the one that happened before;
 *   3. the absences are source facts, not placeholders.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ADMISSION_ERRORS, absent, createMutationAdmission, isAbsent,
} = require('../lib/mutation-admission.js');
const {
  ABSENCE_REASONS,
  AUDIT_ACTION,
  DEFAULT_WORKSPACE,
  createIngestApprovalAuditWriter,
} = require('../lib/workbench/ingest-approval-audit-writer.js');

const FIXED_CLOCK = () => new Date('2026-08-16T12:00:00.000Z');

function makeGraph() {
  const writes = [];
  return {
    writes,
    appendAuditEvent(event, opts) {
      writes.push({ event, opts });
      return { auditId: `audit-${writes.length}` };
    },
  };
}

function makeWriter(overrides = {}) {
  const graph = overrides.graph || makeGraph();
  const admission = overrides.admission || createMutationAdmission({ clock: FIXED_CLOCK, identityEvaluator: absent('test seam: this case exercises admission, not identity enforcement') });
  const record = createIngestApprovalAuditWriter({ graph, admission, hashResult: () => 'result-hash' });
  return { graph, admission, record };
}

const APPROVAL = Object.freeze({
  id: 'approval-1',
  context: { snapshot: { workspaceId: 'default', snapshotHash: 'snap-hash' } },
});
const RECEIPT = Object.freeze({ decision: 'approved', actionOutcome: 'applied' });

test('routed caller: an admitted write reaches the sink unchanged', () => {
  const { graph, record } = makeWriter();

  const recorded = record(APPROVAL, RECEIPT, { plugin: 'output' });

  assert.equal(graph.writes.length, 1);
  const { event, opts } = graph.writes[0];
  assert.equal(event.eventType, 'APPROVAL_APPROVED');
  assert.equal(event.targetType, 'ingest_approval');
  assert.equal(event.targetId, 'approval-1');
  assert.equal(event.details.snapshotHash, 'snap-hash');
  assert.equal(event.details.pluginResultRef, 'result-hash');
  assert.equal(event.details.actionOutcome, 'applied');
  assert.equal(event.details.executionGuarantee, 'bounded_action_outcome');
  assert.deepEqual(opts, { workspaceId: 'default' });
  // The caller's return contract is preserved: it still gets the audit event.
  assert.equal(recorded.auditId, 'audit-1');
});

test('routed caller: a rejected decision still writes the rejection event', () => {
  const { graph, record } = makeWriter();

  record(APPROVAL, { decision: 'rejected', actionOutcome: 'blocked' });

  assert.equal(graph.writes[0].event.eventType, 'APPROVAL_REJECTED');
});

test('routed caller: a refused admission never reaches the sink', () => {
  const graph = makeGraph();
  // An admission that refuses everything stands in for the enforcement that
  // gates 3-8 will switch on. What matters is not why it refused but that the
  // write is unreachable when it does.
  const admission = { admit: () => ({ admitted: false, reason: 'identity.invalid_claim' }) };
  const { record } = makeWriter({ graph, admission });

  assert.throws(() => record(APPROVAL, RECEIPT), (error) => {
    assert.equal(error.code, 'MUTATION_ADMISSION_REFUSED');
    assert.equal(error.admissionReason, 'identity.invalid_claim');
    return true;
  });

  assert.equal(graph.writes.length, 0, 'the sink must be unreachable on refusal');
});

test('routed caller: the refusal joins the existing audit-gap path', () => {
  // lib/workbench/ingest-approval-audit.js turns a throw into
  // audit_append_failed and then into AUDIT_EVIDENCE_MISSING -- "the durable
  // part happened, the evidence did not", explicitly non-retryable. Throwing
  // rather than returning null is what puts a refusal on that existing bounded
  // path instead of inventing a second one.
  const { recordAuditEvidence } = require('../lib/workbench/ingest-approval-audit.js');
  const admission = { admit: () => ({ admitted: false, reason: 'admission.context_incomplete' }) };
  const { record } = makeWriter({ admission });

  const outcome = recordAuditEvidence(record, APPROVAL, RECEIPT, null);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'audit_append_failed');
});

test('routed caller: a missing workspace resolves to the same default as before', () => {
  const { graph, record } = makeWriter();

  // Previously `{ workspaceId: undefined }` went to the sink, where
  // normalizeAuditEvent coerced it to 'default'. The seam refuses an empty
  // workspace, so the fallback is resolved at the caller -- to the same value,
  // but decided in the open, which is what ADR-011 asks of a tenancy boundary.
  record({ id: 'approval-2', context: { snapshot: {} } }, RECEIPT);

  assert.deepEqual(graph.writes[0].opts, { workspaceId: DEFAULT_WORKSPACE });
});

test('routed caller: absences are declared with reasons, not left missing', () => {
  const captured = [];
  const admission = {
    admit: (context, mutate) => { captured.push(context); return { admitted: true, result: mutate() }; },
  };
  const { record } = makeWriter({ admission });

  record(APPROVAL, RECEIPT);

  const [context] = captured;
  assert.equal(context.workspaceId, 'default');
  assert.equal(context.action, AUDIT_ACTION);

  for (const field of ['identityClaim', 'delegationContext', 'connectorContext']) {
    assert.ok(isAbsent(context[field]), `${field} must be a declared absence`);
    assert.equal(context[field].reason, ABSENCE_REASONS[field]);
  }

  // These reasons are source facts about this caller, not placeholders to be
  // swapped for a synthetic identity later. When enforcement is switched on,
  // "under what policy is this accepted as a system actor?" is a decision made
  // here, with the reason already written down.
  assert.match(ABSENCE_REASONS.identityClaim, /not modelled yet/);
});

test('routed caller: the real seam refuses an incomplete context', () => {
  // Not the stub: the actual admission module, proving the wiring rejects.
  const graph = makeGraph();
  const admission = createMutationAdmission({ clock: FIXED_CLOCK, identityEvaluator: absent('test seam: this case exercises admission, not identity enforcement') });
  const record = createIngestApprovalAuditWriter({ graph, admission, hashResult: () => '' });

  // A snapshot whose workspace is an empty string, which the seam treats as
  // present-but-empty rather than as a declared absence.
  assert.throws(
    () => record({ id: 'a', context: { snapshot: { workspaceId: '   ' } } }, RECEIPT),
    /MUTATION_ADMISSION_REFUSED|admission/,
  );
  assert.equal(graph.writes.length, 0);
});

test('routed caller: construction refuses an incomplete wiring', () => {
  const admission = createMutationAdmission({ clock: FIXED_CLOCK, identityEvaluator: absent('test seam: this case exercises admission, not identity enforcement') });
  assert.throws(() => createIngestApprovalAuditWriter({ admission, hashResult: () => '' }), /audit sink/);
  assert.throws(() => createIngestApprovalAuditWriter({ graph: makeGraph(), hashResult: () => '' }), /admission seam/);
  assert.throws(() => createIngestApprovalAuditWriter({ graph: makeGraph(), admission }), /result hasher/);
});

test('routed caller: admission errors stay distinguishable', () => {
  // The seam's vocabulary reaches the caller, so a refusal can be told from an
  // ordinary write failure without parsing a message.
  assert.equal(ADMISSION_ERRORS.CONTEXT_INVALID, 'admission.context_invalid');
});

// ─── #3042: the audit record names the identity state it was written in ──────

test('routed caller: an unenforced seam marks the receipt and the evidence as a declared absence (#3042)', () => {
  const { graph, record } = makeWriter();
  const receipt = { ...RECEIPT };

  record(APPROVAL, receipt, { plugin: 'output' });

  // The receipt is finalized before the audit write, so it names the seam's
  // permanent wiring posture: no evaluator, declared absence, with the reason
  // this writer was constructed under.
  const posture = record.identityPosture();
  assert.equal(posture.identityState, 'absent');
  assert.match(posture.identityReason, /test seam/);
  // The audit event is built inside the admitted write, so it carries the
  // decision's own state and the *context's* declared-absence reason.
  assert.equal(graph.writes[0].event.details.identityState, 'absent');
  assert.match(graph.writes[0].event.details.identityReason, /no identity claim/);
  assert.equal(graph.writes[0].event.details.executionGuarantee, 'bounded_action_outcome');
});

test('routed caller: an enforced seam does not pre-label the receipt as enforced (#3042)', () => {
  const graph = makeGraph();
  const admission = createMutationAdmission({
    clock: FIXED_CLOCK,
    identityEvaluator: () => ({ decision: 'allow', allowed: true }),
  });
  const record = createIngestApprovalAuditWriter({ graph, admission, hashResult: () => 'result-hash' });
  const receipt = { ...RECEIPT };

  record(APPROVAL, receipt, { plugin: 'output' });

  // The receipt is finalized before the admission runs, so an evaluator's
  // presence proves only that a gate exists -- not that this approval passed
  // it. The receipt says what is true at that moment; the audit event, built
  // inside the admitted write, carries the decision that was actually reached.
  assert.equal(record.identityPosture().identityState, 'not_evaluated');
  assert.equal(graph.writes[0].event.details.identityState, 'enforced');
  assert.equal(Object.hasOwn(graph.writes[0].event.details, 'identityReason'), false);
});

test('routed caller: a reused writer reports the same wiring posture for every approval (#3042)', () => {
  // A writer is constructed once and reused for every approval, and a receipt
  // is finalized before its own admission runs. A per-approval cache would let
  // one approval's state be stamped onto another's receipt -- durable, and
  // impossible for the later admission to correct. The posture is therefore a
  // function of the seam's wiring alone, identical for every approval.
  const graph = makeGraph();
  const admission = createMutationAdmission({
    clock: FIXED_CLOCK,
    identityEvaluator: () => ({ decision: 'allow', allowed: true }),
  });
  const record = createIngestApprovalAuditWriter({ graph, admission, hashResult: () => 'result-hash' });

  const approvalB = { ...APPROVAL, id: 'approval-b', context: { snapshot: { workspaceId: 'ws-b', snapshotHash: 's' } } };
  record(approvalB, { ...RECEIPT });

  // B was admitted. A's receipt -- finalized before A's own admission -- must
  // not inherit the state B reached.
  assert.equal(record.identityPosture().identityState, 'not_evaluated');
  assert.notEqual(record.identityPosture().identityState, 'enforced');
});

test('routed caller: a refused write does not change the receipt posture (#3042)', () => {
  const graph = makeGraph();
  const admission = createMutationAdmission({
    clock: FIXED_CLOCK,
    identityEvaluator: () => ({ decision: 'block', allowed: false, reason: 'identity.workspace_mismatch' }),
  });
  const record = createIngestApprovalAuditWriter({ graph, admission, hashResult: () => 'result-hash' });

  assert.throws(() => record(APPROVAL, { ...RECEIPT }));

  // The refusal never finalized a receipt, and the reader must not invent a
  // state from a write that never happened.
  assert.equal(record.identityPosture().identityState, 'not_evaluated');
  assert.equal(graph.writes.length, 0);
});

test('routed caller: the identity state reaches the ledger evidence payload (#3042)', () => {
  const graph = makeGraph();
  const appended = [];
  const ledger = {
    append({ operationId, event, mutate }) {
      const result = mutate();
      appended.push({ operationId, event });
      return { receipt: { receiptId: 'trust-receipt-1' }, result };
    },
  };
  const admission = createMutationAdmission({ clock: FIXED_CLOCK, identityEvaluator: absent('ledger seam: no claim reaches this caller') });
  const record = createIngestApprovalAuditWriter({ graph, admission, hashResult: () => 'result-hash', ledger });

  const recorded = record(APPROVAL, { ...RECEIPT }, { plugin: 'output' });

  assert.equal(recorded.trustReceiptId, 'trust-receipt-1');
  assert.equal(appended.length, 1);
  // The ledger event is the evidence an operator reads later; the state has to
  // be in its metadata or the durable trail cannot tell the two apart.
  assert.equal(appended[0].event.metadata.identityState, 'absent');
  assert.match(appended[0].event.metadata.identityReason, /no identity claim/);
});

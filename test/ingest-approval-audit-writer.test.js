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

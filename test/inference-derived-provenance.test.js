'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const Kernel = require('../kernel');
const {
  variable,
  constant,
  atom,
  createRule,
} = require('../lib/inference-rule-ir');
const { evaluateSemiNaive } = require('../lib/inference-semi-naive');
const {
  DERIVED_STATES,
  BELIEF_SEMANTICS,
  buildDerivedRecord,
  transitionDerivedRecord,
  derivedStateAt,
  canBackTrustReceipt,
} = require('../lib/inference-derived-record');
const {
  findDependents,
  withdrawDependents,
  trustReceiptStatusAt,
  currentTrustReceiptStatus,
} = require('../lib/inference-derived-dependency');
const {
  DERIVED_ADMISSION_STATUS,
  buildCandidateInput,
  admitDerivedRecord,
} = require('../lib/inference-derived-admission');

const DERIVED_AT = '2026-09-28T01:10:00.000Z';

function fact(predicate, ...values) {
  return atom(predicate, values.map(constant));
}

function deriveAffectsCandidate() {
  const rule = createRule({
    id: 'rule:affects-through-type',
    head: atom('affects', [variable('X'), variable('Z')]),
    body: [
      atom('CAUSES', [variable('X'), variable('Y')]),
      atom('is_a', [variable('Y'), variable('Z')]),
    ],
  });
  const result = evaluateSemiNaive([rule], [
    fact('CAUSES', 'smoking', 'cancer'),
    fact('is_a', 'cancer', 'disease'),
  ], { timeoutMs: 10_000 });
  return result.derivedCandidates[0];
}

function buildRecord(candidate = deriveAffectsCandidate()) {
  return buildDerivedRecord(candidate, {
    workspaceId: 'ws-inference',
    graphSnapshotId: 'graph-snapshot-001',
    ruleSnapshotId: 'rule-snapshot-001',
    derivedAt: DERIVED_AT,
    supportDetails: [
      {
        fact: fact('CAUSES', 'smoking', 'cancer'),
        provenanceRefs: ['prov_source_causes'],
        sourceRefs: ['doc:causes'],
      },
      {
        fact: fact('is_a', 'cancer', 'disease'),
        provenanceRefs: ['prov_source_type'],
        sourceRefs: ['doc:types'],
      },
    ],
  });
}

function forcedAllowAdmission(record) {
  return {
    outcome: 'allow',
    reason: 'test_allow',
    graphWrite: true,
    workspaceId: record.workspaceId,
    provenanceId: record.derivationId,
    receiptId: `receipt_${record.derivationId.slice(5, 21)}`,
    trustPolicyVersion: 'test-policy-v1',
    receipt: {
      receiptId: `receipt_${record.derivationId.slice(5, 21)}`,
      receiptKind: 'memory_admission_receipt',
      decision: 'allow',
      status: 'admitted',
      admissionId: `admission_${record.derivationId.slice(5, 21)}`,
      workspaceId: record.workspaceId,
      provenanceId: record.derivationId,
      trustPolicyVersion: 'test-policy-v1',
      createdAt: DERIVED_AT,
    },
  };
}

test('derived record pins rule, exact supports, transitive provenance and uncalibrated belief', () => {
  const record = buildRecord();

  assert.equal(record.state, DERIVED_STATES.PROVISIONAL);
  assert.equal(record.ruleId, 'rule:affects-through-type');
  assert.deepEqual(record.directSupportKeys, [
    '["CAUSES","smoking","cancer"]',
    '["is_a","cancer","disease"]',
  ]);
  assert.deepEqual(record.transitiveProvenanceRefs, [
    'prov_source_causes',
    'prov_source_type',
  ]);
  assert.equal(record.belief.value, null);
  assert.equal(record.belief.semantics, BELIEF_SEMANTICS);
  assert.match(record.derivationId, /^prov_[0-9a-f]{32}$/);
});

test('same candidate, snapshots and supports reproduce the same derivation identity', () => {
  const candidate = deriveAffectsCandidate();
  const left = buildRecord(candidate);
  const right = buildDerivedRecord(candidate, {
    workspaceId: 'ws-inference',
    graphSnapshotId: 'graph-snapshot-001',
    ruleSnapshotId: 'rule-snapshot-001',
    derivedAt: '2026-09-28T02:00:00.000Z',
    supportDetails: [
      {
        fact: fact('is_a', 'cancer', 'disease'),
        sourceRefs: ['doc:types'],
        provenanceRefs: ['prov_source_type'],
      },
      {
        fact: fact('CAUSES', 'smoking', 'cancer'),
        sourceRefs: ['doc:causes'],
        provenanceRefs: ['prov_source_causes'],
      },
    ],
  });

  assert.equal(left.derivationId, right.derivationId);
  assert.deepEqual(left.directSupportKeys, right.directSupportKeys);
  assert.deepEqual(left.bindings, right.bindings);
});

test('support detail coverage is exact and missing provenance fails closed', () => {
  const candidate = deriveAffectsCandidate();

  assert.throws(() => buildDerivedRecord(candidate, {
    workspaceId: 'ws-inference',
    graphSnapshotId: 'g',
    ruleSnapshotId: 'r',
    derivedAt: DERIVED_AT,
    supportDetails: [{
      fact: fact('CAUSES', 'smoking', 'cancer'),
      provenanceRefs: ['prov_source_causes'],
    }],
  }), /exactly cover/);

  assert.throws(() => buildDerivedRecord(candidate, {
    workspaceId: 'ws-inference',
    graphSnapshotId: 'g',
    ruleSnapshotId: 'r',
    derivedAt: DERIVED_AT,
    supportDetails: [
      { fact: fact('CAUSES', 'smoking', 'cancer') },
      { fact: fact('is_a', 'cancer', 'disease'), provenanceRefs: ['prov_type'] },
    ],
  }), /must carry provenance\/source identity/);
});

test('candidate input links Trust Receipt provenance id to the derivation record', () => {
  const record = buildRecord();
  const candidate = buildCandidateInput(record);

  assert.equal(candidate.provenance.provenanceId, record.derivationId);
  assert.equal(candidate.provenance.sourceType, 'background_inference');
  assert.equal(candidate.proposedEdge.from, 'smoking');
  assert.equal(candidate.proposedEdge.relation, 'affects');
  assert.equal(candidate.proposedEdge.to, 'disease');
  assert.equal(candidate.proposedEdge.derivation.derivationId, record.derivationId);
  assert.ok(candidate.proposedEdge.evidence.includes(`rule:${record.ruleId}`));
  for (const supportKey of record.directSupportKeys) {
    assert.ok(candidate.proposedEdge.evidence.includes(`support:${supportKey}`));
  }
});

test('route recommendation alone cannot admit without allow + committed receipt + provenance link', () => {
  const record = buildRecord();
  const result = admitDerivedRecord(record, {
    ingestCandidateClaim: (candidate) => ({
      candidate: { ...candidate, status: 'accepted' },
      conflict: { conflict: false, recommendation: 'accept' },
      admission: { outcome: 'allow', provenanceId: record.derivationId },
    }),
  }, { at: DERIVED_AT });

  assert.equal(result.status, DERIVED_ADMISSION_STATUS.HELD);
  assert.equal(result.reason, 'canonical_receipt_not_committed');
  assert.equal(result.record.state, DERIVED_STATES.PROVISIONAL);
});

test('receipt with the wrong provenance id cannot admit the derivation', () => {
  const record = buildRecord();
  const result = admitDerivedRecord(record, {
    ingestCandidateClaim: (candidate) => ({
      candidate: { ...candidate, status: 'accepted' },
      conflict: { conflict: false, recommendation: 'accept' },
      admission: {
        outcome: 'allow',
        provenanceId: 'prov_wrong',
        receiptId: 'receipt-wrong',
      },
      mutation: {
        operationId: 'op-wrong',
        receiptId: 'receipt-wrong',
      },
    }),
  }, { at: DERIVED_AT });

  assert.equal(result.status, DERIVED_ADMISSION_STATUS.HELD);
  assert.equal(result.record.state, DERIVED_STATES.PROVISIONAL);
});

test('verification contradiction stops before candidate ingress', () => {
  const record = buildRecord();
  let ingressCalls = 0;
  const result = admitDerivedRecord(record, {
    verifyDerived: () => ({ status: 'contradicted', evidence: ['opposition'] }),
    ingestCandidateClaim: () => {
      ingressCalls += 1;
      throw new Error('must not run');
    },
  }, { at: '2026-09-28T01:11:00.000Z' });

  assert.equal(ingressCalls, 0);
  assert.equal(result.status, DERIVED_ADMISSION_STATUS.CONTRADICTED);
  assert.equal(result.record.state, DERIVED_STATES.CONTRADICTED);
  assert.equal(result.record.history.at(-1).reason, 'verification_contradicted');
});

test('existing Kernel candidate path keeps low-trust inference provisional by default', () => {
  const kernel = new Kernel({
    noLoad: true,
    useSQLite: false,
    loadPlugins: false,
    memoryStoreUseSQLite: false,
  });
  const record = buildRecord();

  try {
    const before = kernel.graph.getEdges('smoking', record.workspaceId);
    const result = admitDerivedRecord(record, {
      ingestCandidateClaim: kernel.ingestCandidateClaim.bind(kernel),
    }, { at: '2026-09-28T01:12:00.000Z' });
    const after = kernel.graph.getEdges('smoking', record.workspaceId);

    assert.equal(result.status, DERIVED_ADMISSION_STATUS.HELD);
    assert.equal(result.record.state, DERIVED_STATES.PROVISIONAL);
    assert.equal(after.length, before.length);
    assert.equal(
      after.some((edge) => edge.relation === 'affects' && edge.to === 'disease'),
      false,
    );
  } finally {
    kernel.graph.close();
  }
});

test('existing Kernel route admits only after the admission evaluator returns allow + receipt', () => {
  const kernel = new Kernel({
    noLoad: true,
    useSQLite: false,
    loadPlugins: false,
    memoryStoreUseSQLite: false,
  });
  const record = buildRecord();
  const original = kernel._evaluateLearnAdmission.bind(kernel);
  kernel._evaluateLearnAdmission = () => forcedAllowAdmission(record);

  try {
    const result = admitDerivedRecord(record, {
      ingestCandidateClaim: kernel.ingestCandidateClaim.bind(kernel),
    }, { at: '2026-09-28T01:13:00.000Z' });

    assert.equal(result.status, DERIVED_ADMISSION_STATUS.ADMITTED);
    assert.equal(result.record.state, DERIVED_STATES.ADMITTED);
    assert.equal(result.record.trustReceiptId, forcedAllowAdmission(record).receiptId);
    assert.equal(canBackTrustReceipt(result.record), true);
    assert.equal(result.routeResult.admission.provenanceId, record.derivationId);

    const edge = kernel.graph.getEdges('smoking', record.workspaceId)
      .find((item) => item.relation === 'affects' && item.to === 'disease');
    assert.ok(edge);
    assert.equal(edge.provenance.provenanceId, record.derivationId);
  } finally {
    kernel._evaluateLearnAdmission = original;
    kernel.graph.close();
  }
});

test('withdrawing one source support cascades to downstream derivations and invalidates current receipt trust', () => {
  const first = transitionDerivedRecord(buildRecord(), DERIVED_STATES.ADMITTED, {
    at: '2026-09-28T01:13:00.000Z',
    reason: 'candidate_admitted',
    receiptId: 'receipt-first',
    candidateId: 'cand-first',
    operationId: 'op-first',
  });

  const secondCandidate = {
    fact: fact('risk_flag', 'smoking', 'disease'),
    ruleId: 'rule:risk-from-affects',
    bindings: [{ variable: 'X', value: 'smoking' }],
    directSupports: [first.fact],
  };
  const secondProvisional = buildDerivedRecord(secondCandidate, {
    workspaceId: 'ws-inference',
    graphSnapshotId: 'graph-snapshot-002',
    ruleSnapshotId: 'rule-snapshot-002',
    derivedAt: '2026-09-28T01:14:00.000Z',
    supportDetails: [{
      fact: first.fact,
      derivedRecordId: first.derivationId,
      provenanceRefs: [first.derivationId],
      transitiveProvenanceRefs: first.transitiveProvenanceRefs,
      state: 'admitted',
    }],
  });
  const second = transitionDerivedRecord(secondProvisional, DERIVED_STATES.ADMITTED, {
    at: '2026-09-28T01:15:00.000Z',
    reason: 'candidate_admitted',
    receiptId: 'receipt-second',
    candidateId: 'cand-second',
    operationId: 'op-second',
  });

  assert.deepEqual(
    findDependents([first, second], { provenanceId: 'prov_source_causes' })
      .map((record) => record.derivationId),
    [first.derivationId],
  );

  const withdrawn = withdrawDependents(
    [first, second],
    { provenanceId: 'prov_source_causes' },
    {
      at: '2026-09-28T01:20:00.000Z',
      reason: 'support_superseded',
    },
  );

  assert.deepEqual(withdrawn.affectedDerivationIds, [
    first.derivationId,
    second.derivationId,
  ].sort());
  assert.deepEqual(withdrawn.reevaluateDerivationIds, withdrawn.affectedDerivationIds);

  const firstAfter = withdrawn.records.find((record) => record.derivationId === first.derivationId);
  const secondAfter = withdrawn.records.find((record) => record.derivationId === second.derivationId);
  assert.equal(firstAfter.state, DERIVED_STATES.WITHDRAWN);
  assert.equal(secondAfter.state, DERIVED_STATES.WITHDRAWN);
  assert.equal(currentTrustReceiptStatus(firstAfter, 'receipt-first').valid, false);
  assert.equal(currentTrustReceiptStatus(secondAfter, 'receipt-second').valid, false);

  assert.equal(
    trustReceiptStatusAt(firstAfter, 'receipt-first', '2026-09-28T01:16:00.000Z').valid,
    true,
  );
  assert.equal(
    trustReceiptStatusAt(firstAfter, 'receipt-first', '2026-09-28T01:21:00.000Z').valid,
    false,
  );
  assert.equal(
    derivedStateAt(firstAfter, '2026-09-28T01:21:00.000Z').reason,
    'support_superseded',
  );
});

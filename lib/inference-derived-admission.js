'use strict';

const {
  DERIVED_RECORD_SCHEMA_VERSION,
  DERIVED_STATES,
  transitionDerivedRecord,
} = require('./inference-derived-record');

const DERIVED_ADMISSION_STATUS = Object.freeze({
  ADMITTED: 'admitted',
  HELD: 'held',
  CONTRADICTED: 'contradicted',
  INVALID: 'invalid',
  ERROR: 'error',
});

function validDerivedRecord(record) {
  return Boolean(
    record
    && record.schemaVersion === DERIVED_RECORD_SCHEMA_VERSION
    && record.state === DERIVED_STATES.PROVISIONAL
  );
}

function binaryGroundFact(record) {
  const fact = record.fact;
  return Boolean(
    fact
    && typeof fact.predicate === 'string'
    && Array.isArray(fact.args)
    && fact.args.length === 2
    && fact.args.every((term) => term && term.kind === 'constant' && typeof term.value === 'string')
  );
}

function candidateIdFor(record) {
  return `cand_inference_${record.derivationId.replace(/^prov_/, '')}`;
}

function verificationStatus(value) {
  if (!value || typeof value !== 'object') return 'unknown';
  const status = String(value.status || value.verdict || '').toLowerCase();
  if (['contradicted', 'contradiction', 'celiski', 'refuted'].includes(status)) {
    return 'contradicted';
  }
  if (['verified', 'dogrulandi', 'supported'].includes(status)) return 'verified';
  return 'unknown';
}

function buildCandidateInput(record) {
  if (!validDerivedRecord(record)) {
    throw new TypeError('provisional derived record is required');
  }
  if (!binaryGroundFact(record)) {
    throw new TypeError('derived admission currently requires a binary ground fact');
  }

  const [fromTerm, toTerm] = record.fact.args;
  const evidence = [
    `derivation:${record.derivationId}`,
    `rule:${record.ruleId}`,
    ...record.directSupportKeys.map((key) => `support:${key}`),
  ];

  return Object.freeze({
    candidateId: candidateIdFor(record),
    claim: `${fromTerm.value} ${record.fact.predicate} ${toTerm.value}`,
    proposedEdge: Object.freeze({
      from: fromTerm.value,
      relation: record.fact.predicate,
      to: toTerm.value,
      source: 'background_inference',
      sourceRef: record.derivationId,
      evidence: Object.freeze(evidence),
      derivation: record,
    }),
    provenance: Object.freeze({
      provenanceId: record.derivationId,
      sourceType: 'background_inference',
      sourceSubType: 'derived_fact',
      sourceRef: record.derivationId,
      sourceTitle: `derived by ${record.ruleId}`,
      actor: 'inference',
      timestamp: record.derivedAt,
      workspaceId: record.workspaceId,
    }),
    workspaceId: record.workspaceId,
    createdAt: record.derivedAt,
  });
}

function held(record, reason, routeResult = null, verification = null) {
  return Object.freeze({
    status: DERIVED_ADMISSION_STATUS.HELD,
    reason,
    record,
    routeResult,
    verification,
  });
}

function contradicted(record, at, reason, verification = null, routeResult = null) {
  const next = transitionDerivedRecord(record, DERIVED_STATES.CONTRADICTED, {
    at,
    reason,
    candidateId: routeResult?.candidate?.candidateId || '',
    receiptId: routeResult?.mutation?.receiptId || '',
    operationId: routeResult?.mutation?.operationId || '',
  });
  return Object.freeze({
    status: DERIVED_ADMISSION_STATUS.CONTRADICTED,
    reason,
    record: next,
    routeResult,
    verification,
  });
}

function admitDerivedRecord(record, deps = {}, opts = {}) {
  if (!validDerivedRecord(record)) {
    return Object.freeze({
      status: DERIVED_ADMISSION_STATUS.INVALID,
      reason: 'provisional_derived_record_required',
      record,
      routeResult: null,
      verification: null,
    });
  }
  if (!binaryGroundFact(record)) {
    return Object.freeze({
      status: DERIVED_ADMISSION_STATUS.INVALID,
      reason: 'binary_ground_fact_required',
      record,
      routeResult: null,
      verification: null,
    });
  }
  if (typeof deps.ingestCandidateClaim !== 'function') {
    return Object.freeze({
      status: DERIVED_ADMISSION_STATUS.INVALID,
      reason: 'ingest_candidate_claim_required',
      record,
      routeResult: null,
      verification: null,
    });
  }

  const at = typeof opts.at === 'string' && opts.at.trim()
    ? opts.at.trim()
    : record.derivedAt;

  let verification = null;
  if (typeof deps.verifyDerived === 'function') {
    try {
      verification = deps.verifyDerived(record.fact, record);
    } catch (_) {
      return held(record, 'verification_unavailable');
    }
    if (verificationStatus(verification) === 'contradicted') {
      return contradicted(
        record,
        at,
        'verification_contradicted',
        verification,
      );
    }
  }

  if (record.supports.some(support => support.derivedRecordId && support.state !== 'admitted')) {
    return held(record, 'support_not_admitted');
  }
  const candidateInput = buildCandidateInput(record);
  let routeResult;
  try {
    routeResult = deps.ingestCandidateClaim(candidateInput, {
      workspaceId: record.workspaceId,
      actor: 'inference',
      sourceType: 'background_inference',
      sourceSubType: 'derived_fact',
      sourceRef: record.derivationId,
      provenanceId: record.derivationId,
    });
  } catch (error) {
    return Object.freeze({
      status: DERIVED_ADMISSION_STATUS.ERROR,
      reason: 'candidate_ingress_failed',
      record,
      routeResult: null,
      verification,
      errorCode: typeof error?.code === 'string' ? error.code : '',
    });
  }

  const conflict = routeResult?.conflict;
  const candidate = routeResult?.candidate;
  if (conflict?.conflict === true || candidate?.status === 'rejected') {
    return contradicted(
      record,
      at,
      conflict?.conflict === true ? 'conflict_detected' : 'candidate_rejected',
      verification,
      routeResult,
    );
  }

  const admission = routeResult?.admission;
  const receiptId = routeResult?.mutation?.receiptId || admission?.receiptId || '';
  const provenanceId = admission?.provenanceId || admission?.receipt?.provenanceId || '';
  const committedReceipt = opts.requireCommittedReceipt !== true || (typeof routeResult?.mutation?.receiptId === 'string' && routeResult.mutation.receiptId !== '');
  const canonical = committedReceipt && candidate?.status === 'accepted'
    && admission?.outcome === 'allow'
    && typeof receiptId === 'string'
    && receiptId !== ''
    && provenanceId === record.derivationId;

  if (!canonical) {
    const reason = admission?.outcome && admission.outcome !== 'allow'
      ? `admission_${admission.outcome}`
      : candidate?.status === 'pending'
        ? 'candidate_pending'
        : 'canonical_receipt_not_committed';
    return held(record, reason, routeResult, verification);
  }

  const next = transitionDerivedRecord(record, DERIVED_STATES.ADMITTED, {
    at,
    reason: 'candidate_admitted',
    receiptId,
    candidateId: candidate.candidateId,
    operationId: routeResult?.mutation?.operationId || '',
  });

  return Object.freeze({
    status: DERIVED_ADMISSION_STATUS.ADMITTED,
    reason: 'candidate_admitted',
    record: next,
    routeResult,
    verification,
  });
}

module.exports = {
  DERIVED_ADMISSION_STATUS,
  buildCandidateInput,
  admitDerivedRecord,
};

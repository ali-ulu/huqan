'use strict';

const crypto = require('crypto');
const { factKey } = require('./inference-semi-naive-values');

const DERIVED_RECORD_SCHEMA_VERSION = 'huqan.derived-fact.v1';
const DERIVED_STATES = Object.freeze({
  PROVISIONAL: 'provisional',
  ADMITTED: 'admitted',
  CONTRADICTED: 'contradicted',
  SUPERSEDED: 'superseded',
  WITHDRAWN: 'withdrawn',
});

const BELIEF_SEMANTICS = 'uncalibrated_inference_does_not_assign_belief';

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function isoTimestamp(value, label) {
  const text = nonEmpty(value, label);
  if (Number.isNaN(Date.parse(text))) {
    throw new TypeError(`${label} must be an ISO timestamp`);
  }
  return text;
}

function sortedUniqueStrings(values, label) {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  return [...new Set(values.map((value) => nonEmpty(value, label)))].sort();
}

function normalizeSupportDetail(input, allowProvisional = false) {
  if (!input || typeof input !== 'object' || !input.fact) {
    throw new TypeError('support detail must contain fact');
  }
  const key = factKey(input.fact);
  const provenanceRefs = sortedUniqueStrings(input.provenanceRefs, 'support.provenanceRefs');
  const sourceRefs = sortedUniqueStrings(input.sourceRefs, 'support.sourceRefs');
  const transitiveProvenanceRefs = sortedUniqueStrings(
    input.transitiveProvenanceRefs,
    'support.transitiveProvenanceRefs',
  );
  const transitiveSourceRefs = sortedUniqueStrings(
    input.transitiveSourceRefs,
    'support.transitiveSourceRefs',
  );
  const derivedRecordId = typeof input.derivedRecordId === 'string'
    ? input.derivedRecordId.trim()
    : '';
  const state = typeof input.state === 'string' && input.state.trim()
    ? input.state.trim()
    : 'active';
  if (!['active', 'admitted', ...(allowProvisional ? ['provisional'] : [])].includes(state)) {
    throw new TypeError(`support ${key} is not active/admitted`);
  }
  if (derivedRecordId && state !== 'admitted' && !(allowProvisional && state === 'provisional')) {
    throw new TypeError(`derived support ${key} must be admitted`);
  }

  if (
    provenanceRefs.length === 0
    && sourceRefs.length === 0
    && transitiveProvenanceRefs.length === 0
    && transitiveSourceRefs.length === 0
    && !derivedRecordId
  ) {
    throw new TypeError(`support ${key} must carry provenance/source identity`);
  }

  return Object.freeze({
    fact: input.fact,
    factKey: key,
    provenanceRefs: Object.freeze(provenanceRefs),
    sourceRefs: Object.freeze(sourceRefs),
    transitiveProvenanceRefs: Object.freeze(transitiveProvenanceRefs),
    transitiveSourceRefs: Object.freeze(transitiveSourceRefs),
    derivedRecordId,
    state,
  });
}

function normalizeSupports(candidate, supportDetails, allowProvisional) {
  if (!Array.isArray(candidate.directSupports) || candidate.directSupports.length === 0) {
    throw new TypeError('derived candidate must contain a complete directSupports array');
  }
  if (!Array.isArray(supportDetails)) {
    throw new TypeError('supportDetails must be an array');
  }

  const expected = [...new Set(candidate.directSupports.map(factKey))].sort();
  const byKey = new Map();
  for (const raw of supportDetails) {
    const detail = normalizeSupportDetail(raw, allowProvisional);
    if (byKey.has(detail.factKey)) {
      throw new TypeError(`duplicate support detail for ${detail.factKey}`);
    }
    byKey.set(detail.factKey, detail);
  }

  const actual = [...byKey.keys()].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError('supportDetails must exactly cover candidate.directSupports');
  }

  return Object.freeze(expected.map((key) => byKey.get(key)));
}

function collectTransitiveProvenanceRefs(supports) {
  const refs = new Set();
  for (const support of supports) {
    for (const ref of support.provenanceRefs) refs.add(ref);
    for (const ref of support.transitiveProvenanceRefs) refs.add(ref);
    if (support.derivedRecordId) refs.add(support.derivedRecordId);
  }
  return Object.freeze([...refs].sort());
}

function collectTransitiveSourceRefs(supports) {
  const refs = new Set();
  for (const support of supports) {
    for (const ref of support.sourceRefs) refs.add(ref);
    for (const ref of support.transitiveSourceRefs) refs.add(ref);
  }
  return Object.freeze([...refs].sort());
}

function normalizedBindings(candidate) {
  if (!Array.isArray(candidate.bindings)) return Object.freeze([]);
  return Object.freeze(
    candidate.bindings
      .map((entry) => Object.freeze({
        variable: nonEmpty(entry.variable, 'binding.variable'),
        value: nonEmpty(entry.value, 'binding.value'),
      }))
      .sort((left, right) => left.variable.localeCompare(right.variable)),
  );
}

function derivationHashInput(fields) {
  return JSON.stringify({
    schemaVersion: DERIVED_RECORD_SCHEMA_VERSION,
    workspaceId: fields.workspaceId,
    factKey: factKey(fields.fact),
    ruleId: fields.ruleId,
    bindings: fields.bindings,
    directSupportKeys: fields.supports.map((support) => support.factKey),
    graphSnapshotId: fields.snapshot.graphSnapshotId,
    ruleSnapshotId: fields.snapshot.ruleSnapshotId,
  });
}

function makeDerivationId(fields) {
  return `prov_${crypto.createHash('sha256')
    .update(derivationHashInput(fields), 'utf8')
    .digest('hex')
    .slice(0, 32)}`;
}

function freezeHistoryEvent(event) {
  return Object.freeze({
    at: event.at,
    state: event.state,
    reason: event.reason,
    previousState: event.previousState || '',
    receiptId: event.receiptId || '',
    candidateId: event.candidateId || '',
    operationId: event.operationId || '',
    supportRef: event.supportRef || '',
  });
}

function buildDerivedRecord(candidate, opts = {}) {
  if (!candidate || typeof candidate !== 'object' || !candidate.fact) {
    throw new TypeError('derived candidate with fact is required');
  }
  const workspaceId = nonEmpty(opts.workspaceId || 'default', 'workspaceId');
  const ruleId = nonEmpty(candidate.ruleId, 'candidate.ruleId');
  const derivedAt = isoTimestamp(opts.derivedAt, 'derivedAt');
  const snapshot = Object.freeze({
    graphSnapshotId: nonEmpty(opts.graphSnapshotId, 'graphSnapshotId'),
    ruleSnapshotId: nonEmpty(opts.ruleSnapshotId, 'ruleSnapshotId'),
  });
  const supports = normalizeSupports(candidate, opts.supportDetails, opts.allowProvisionalSupports === true);
  const bindings = normalizedBindings(candidate);
  const fields = {
    workspaceId,
    fact: candidate.fact,
    ruleId,
    bindings,
    supports,
    snapshot,
  };
  const derivationId = makeDerivationId(fields);
  const directSupports = Object.freeze(supports.map((support) => support.fact));
  const directSupportKeys = Object.freeze(supports.map((support) => support.factKey));
  const transitiveProvenanceRefs = collectTransitiveProvenanceRefs(supports);
  const transitiveSourceRefs = collectTransitiveSourceRefs(supports);

  return Object.freeze({
    schemaVersion: DERIVED_RECORD_SCHEMA_VERSION,
    derivationId,
    workspaceId,
    fact: candidate.fact,
    factKey: factKey(candidate.fact),
    ruleId,
    bindings,
    directSupports,
    directSupportKeys,
    supports,
    transitiveProvenanceRefs,
    transitiveSourceRefs,
    snapshot,
    derivedAt,
    state: DERIVED_STATES.PROVISIONAL,
    belief: Object.freeze({
      value: null,
      semantics: BELIEF_SEMANTICS,
    }),
    trustReceiptId: '',
    candidateId: '',
    mutationOperationId: '',
    history: Object.freeze([
      freezeHistoryEvent({
        at: derivedAt,
        state: DERIVED_STATES.PROVISIONAL,
        reason: 'rule_fired',
      }),
    ]),
  });
}

function transitionDerivedRecord(record, nextState, opts = {}) {
  if (!record || record.schemaVersion !== DERIVED_RECORD_SCHEMA_VERSION) {
    throw new TypeError('valid derived record is required');
  }
  if (!Object.values(DERIVED_STATES).includes(nextState)) {
    throw new TypeError(`unsupported derived state: ${String(nextState)}`);
  }
  const allowed = {
    [DERIVED_STATES.PROVISIONAL]: new Set([
      DERIVED_STATES.ADMITTED,
      DERIVED_STATES.CONTRADICTED,
      DERIVED_STATES.SUPERSEDED,
      DERIVED_STATES.WITHDRAWN,
    ]),
    [DERIVED_STATES.ADMITTED]: new Set([
      DERIVED_STATES.CONTRADICTED,
      DERIVED_STATES.SUPERSEDED,
      DERIVED_STATES.WITHDRAWN,
    ]),
    [DERIVED_STATES.CONTRADICTED]: new Set([]),
    [DERIVED_STATES.SUPERSEDED]: new Set([]),
    [DERIVED_STATES.WITHDRAWN]: new Set([]),
  };
  if (!allowed[record.state] || !allowed[record.state].has(nextState)) {
    throw new TypeError(`derived state transition ${record.state} -> ${nextState} is not allowed`);
  }
  const at = isoTimestamp(opts.at, 'transition.at');
  const reason = nonEmpty(opts.reason, 'transition.reason');
  const previousEvent = record.history[record.history.length - 1];
  if (previousEvent && Date.parse(at) < Date.parse(previousEvent.at)) {
    throw new TypeError('transition.at cannot precede the existing history');
  }

  const receiptId = typeof opts.receiptId === 'string'
    ? opts.receiptId.trim()
    : record.trustReceiptId;
  const candidateId = typeof opts.candidateId === 'string'
    ? opts.candidateId.trim()
    : record.candidateId;
  const operationId = typeof opts.operationId === 'string'
    ? opts.operationId.trim()
    : record.mutationOperationId;

  const event = freezeHistoryEvent({
    at,
    state: nextState,
    reason,
    previousState: record.state,
    receiptId,
    candidateId,
    operationId,
    supportRef: typeof opts.supportRef === 'string' ? opts.supportRef.trim() : '',
  });

  return Object.freeze({
    ...record,
    state: nextState,
    trustReceiptId: receiptId,
    candidateId,
    mutationOperationId: operationId,
    history: Object.freeze([...record.history, event]),
  });
}

function derivedStateAt(record, asOf) {
  if (!record || record.schemaVersion !== DERIVED_RECORD_SCHEMA_VERSION) {
    throw new TypeError('valid derived record is required');
  }
  const boundary = Date.parse(isoTimestamp(asOf, 'asOf'));
  const events = record.history
    .filter((event) => Date.parse(event.at) <= boundary)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  if (events.length === 0) return null;
  const event = events[events.length - 1];
  return Object.freeze({
    derivationId: record.derivationId,
    state: event.state,
    reason: event.reason,
    at: event.at,
    receiptId: event.receiptId,
    candidateId: event.candidateId,
    operationId: event.operationId,
  });
}

function canBackTrustReceipt(record, receiptId = record && record.trustReceiptId) {
  return Boolean(
    record
    && record.schemaVersion === DERIVED_RECORD_SCHEMA_VERSION
    && record.state === DERIVED_STATES.ADMITTED
    && typeof receiptId === 'string'
    && receiptId !== ''
    && record.trustReceiptId === receiptId
  );
}

module.exports = {
  DERIVED_RECORD_SCHEMA_VERSION,
  DERIVED_STATES,
  BELIEF_SEMANTICS,
  buildDerivedRecord,
  transitionDerivedRecord,
  derivedStateAt,
  canBackTrustReceipt,
};

'use strict';

const { hashCanonicalPayload, stableStringify } = require('../hash-chain');
const { verifyApprovalDecisionAttestation } = require('../authority/decision-attestation');
const { readSealedRun } = require('./learning-intake');

const SCHEMA = 'huqan.coder-promotion-receipt.v1';
const FIELDS = ['schemaVersion', 'receiptId', 'approvalId', 'workspaceId', 'tool', 'actionHash',
  'capabilityId', 'inputArtifactDigests', 'previousProcedure', 'nextProcedure', 'sourceRunHashes',
  'qualification', 'outcome', 'receiptHash'];
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 512;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => ({ ok: false, code, trusted: false });
const idFor = (workspaceId, approvalId) => `coder-promotion:${hashCanonicalPayload({ workspaceId, approvalId })}`;

function validProcedure(procedure) {
  if (!object(procedure) || !hex(procedure.hash)
      || !(text(procedure.version) || Number.isInteger(procedure.version) && procedure.version > 0)
      || !text(procedure.kind) || !object(procedure.params) || !object(procedure.preconditions)
      || !object(procedure.postconditions) || !Array.isArray(procedure.evidenceRefs) || !procedure.evidenceRefs.length
      || !object(procedure.scope) || !text(procedure.revision)
      || !(procedure.parentHash === null || hex(procedure.parentHash))) return false;
  const { hash, ...body } = procedure;
  return hashCanonicalPayload(body) === hash;
}

function validReceipt(receipt) {
  if (!object(receipt) || Object.keys(receipt).length !== FIELDS.length
      || FIELDS.some(field => !Object.hasOwn(receipt, field))) return false;
  if (receipt.schemaVersion !== SCHEMA || receipt.tool !== 'terfi'
      || !['approvalId', 'workspaceId', 'capabilityId'].every(field => text(receipt[field]))
      || !hex(receipt.actionHash) || !hex(receipt.receiptHash)
      || !['promoted', 'rolled_back'].includes(receipt.outcome)
      || receipt.receiptId !== idFor(receipt.workspaceId, receipt.approvalId)
      || !validProcedure(receipt.previousProcedure) || !validProcedure(receipt.nextProcedure)
      || receipt.previousProcedure.hash === receipt.nextProcedure.hash) return false;
  const digests = receipt.inputArtifactDigests;
  if (!object(digests) || !Object.keys(digests).length || !Object.values(digests).every(hex)) return false;
  const sources = receipt.sourceRunHashes;
  // Learning intake permits one primary run plus 32 sealed baseline runs.
  if (!Array.isArray(sources) || !sources.length || sources.length > 33
      || sources.some(source => !object(source) || Object.keys(source).length !== 2
        || !text(source.runId) || !hex(source.sourceHash))
      || new Set(sources.map(source => source.runId)).size !== sources.length) return false;
  if (receipt.qualification?.ok !== true || receipt.qualification.qualified !== true
      || receipt.qualification.procedureHash !== receipt.nextProcedure.hash) return false;
  const { receiptHash, ...body } = receipt;
  return hashCanonicalPayload(body) === receiptHash;
}

function buildCoderPromotionReceipt(fields) {
  const body = { ...fields, schemaVersion: SCHEMA, tool: 'terfi',
    receiptId: idFor(fields?.workspaceId, fields?.approvalId) };
  delete body.receiptHash;
  const receipt = { ...body, receiptHash: hashCanonicalPayload(body) };
  if (!validReceipt(receipt)) throw new TypeError('invalid coder promotion receipt');
  return JSON.parse(stableStringify(receipt));
}

// The public key is supplied by the host's trusted pin, never by the receipt.
// This verifies historical evidence; it does not activate a procedure or grant trust.
function verifyCoderPromotionReceipt({ receipt, decisionAttestation, publicKey, expected = {} } = {}) {
  try {
    if (!validReceipt(receipt)) return fail('promotion_receipt_invalid');
    for (const [field, value] of Object.entries(expected)) {
      if (stableStringify(receipt[field]) !== stableStringify(value)) return fail('promotion_binding_mismatch');
    }
    const verified = verifyApprovalDecisionAttestation(decisionAttestation, { publicKey, receipt,
      expected: { approvalId: receipt.approvalId, workspaceId: receipt.workspaceId, tool: 'terfi',
        actionHash: receipt.actionHash, decision: 'approved' }, expectedOutcomeStatus: 'executed' });
    if (!verified.ok) return fail(verified.code);
    return { ok: true, receipt, decisionAttestation, authorityVerified: true, trusted: false };
  } catch { return fail('promotion_receipt_invalid'); }
}

function eventsFor(receipt, decisionAttestation) {
  const base = { runId: receipt.receiptId, workspaceId: receipt.workspaceId };
  return [
    { ...base, eventId: `${base.runId}:start`, type: 'run_started', payload: { receipt, decisionAttestation } },
    { ...base, eventId: `${base.runId}:receipt`, type: 'memory_update', causedByEventId: `${base.runId}:start`,
      payload: { receiptHash: receipt.receiptHash } },
    { ...base, eventId: `${base.runId}:close`, type: 'run_closed', causedByEventId: `${base.runId}:receipt`,
      payload: { receiptHash: receipt.receiptHash } },
  ];
}

function checkSources(journal, receipt) {
  for (const source of receipt.sourceRunHashes) {
    if (source.runId === receipt.receiptId) return fail('promotion_source_invalid');
    const sealed = readSealedRun(journal, source.runId, receipt.workspaceId);
    if (!sealed.ok) return fail(sealed.code);
    if (sealed.sourceHash !== source.sourceHash) return fail('promotion_source_hash_mismatch');
  }
  return { ok: true };
}

function checkPrefix(actual, expected) {
  return actual.length <= expected.length && actual.every((event, index) => {
    const { sequence, ...body } = event;
    return sequence === index + 1 && stableStringify(body) === stableStringify(expected[index]);
  });
}

function persistCoderPromotionReceipt(options = {}) {
  const verified = verifyCoderPromotionReceipt(options);
  if (!verified.ok) return verified;
  const { journal, receipt, decisionAttestation } = options;
  try {
    const sources = checkSources(journal, receipt);
    if (!sources.ok) return sources;
    const expected = eventsFor(receipt, decisionAttestation);
    const actual = journal.read(receipt.receiptId);
    if (!checkPrefix(actual, expected)) return fail('promotion_receipt_conflict');
    for (const event of expected) {
      const result = journal.append(event);
      if (!result.ok) return fail(result.code);
    }
    return { ...verified, runId: receipt.receiptId, duplicate: actual.length === expected.length };
  } catch { return fail('promotion_journal_unavailable'); }
}

function readCoderPromotionReceipt({ journal, approvalId, workspaceId, publicKey, expected = {} } = {}) {
  try {
    const events = journal.read(idFor(workspaceId, approvalId));
    if (!events.length) return fail('promotion_receipt_missing');
    const payload = events[0].payload;
    const verified = verifyCoderPromotionReceipt({ ...payload, publicKey, expected: { ...expected, approvalId, workspaceId } });
    if (!verified.ok) return verified;
    const full = eventsFor(payload.receipt, payload.decisionAttestation);
    if (events.length !== full.length || !checkPrefix(events, full) || !journal.manifest(events[0].runId).closed)
      return fail('promotion_receipt_incomplete');
    const sources = checkSources(journal, payload.receipt);
    return sources.ok ? { ...verified, runId: payload.receipt.receiptId } : sources;
  } catch { return fail('promotion_journal_unavailable'); }
}

module.exports = { buildCoderPromotionReceipt, verifyCoderPromotionReceipt,
  persistCoderPromotionReceipt, readCoderPromotionReceipt };

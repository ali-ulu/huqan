'use strict';

const path = require('node:path');
const { stableStringify } = require('../hash-chain');
const { canonicalActionHash } = require('../mcp-operator-capability');
const { verifyDecision } = require('../authority/decision-envelope');
const { buildApprovalDecisionAttestation } = require('../authority/decision-attestation');
const { openJournalConnection } = require('./journal-connection');
const { createExperienceJournal } = require('./journal');
const { readSealedRun } = require('./learning-intake');
const { buildCoderPromotionReceipt, persistCoderPromotionReceipt } = require('./coder-promotion-receipt');

function refuse(code) {
  const error = new Error(code); error.code = code; error.exitCode = 4; throw error;
}

function withJournal(journalPath, readOnly, work) {
  if (!path.isAbsolute(journalPath || '')) refuse('PROMOTION_JOURNAL_ABSOLUTE_REQUIRED');
  const store = openJournalConnection({ dbPath: journalPath, readOnly });
  if (!store) refuse('PROMOTION_JOURNAL_UNAVAILABLE');
  try { return work(createExperienceJournal({ store, readOnly })); }
  finally { store.close(); }
}

function references(artifact) {
  if (Array.isArray(artifact.sourceRunHashes)) return artifact.sourceRunHashes;
  if (!Array.isArray(artifact.compiledSupport) || !Array.isArray(artifact.sourceHashes)
      || artifact.compiledSupport.length !== artifact.sourceHashes.length) refuse('PROMOTION_SOURCES_MISSING');
  return artifact.compiledSupport.map((runId, index) => ({ runId, sourceHash: artifact.sourceHashes[index] }));
}

function preparePromotionReceipt({ flags, candidate, bound, digests, authority }) {
  const { mode, approvalId, envelope, arguments: signedArguments } = authority || {};
  if (mode?.mode !== 'service' || !mode.pin?.signingKey) refuse('PROMOTION_AUTHORITY_REQUIRED');
  if (!signedArguments || stableStringify(digests) !== stableStringify(signedArguments.digests))
    refuse('PROMOTION_INPUT_BINDING_MISMATCH');
  const actionHash = canonicalActionHash({ tool: 'terfi', workspaceId: flags.workspaceId,
    approvalId, arguments: signedArguments });
  const payload = envelope?.payload;
  const verified = verifyDecision(envelope, { publicKey: mode.pin.signingKey,
    now: Date.parse(payload?.decidedAt),
    expected: { approvalId, workspaceId: flags.workspaceId, tool: 'terfi', actionHash, decision: 'approved' } });
  if (!verified.ok) refuse('PROMOTION_ACTION_BINDING_MISMATCH');
  const common = { approvalId, workspaceId: flags.workspaceId, actionHash: payload.actionHash,
    capabilityId: flags.capabilityId, inputArtifactDigests: digests };
  return withJournal(flags.journalPath, true, journal => {
    const build = (previous, next, outcome) => {
      const receipt = buildCoderPromotionReceipt({ ...common, previousProcedure: previous.procedure,
        nextProcedure: next.procedure, sourceRunHashes: references(next), qualification: next.qualification, outcome });
      for (const source of receipt.sourceRunHashes) {
        const sealed = readSealedRun(journal, source.runId, flags.workspaceId);
        if (!sealed.ok || sealed.sourceHash !== source.sourceHash) refuse('PROMOTION_SOURCE_BINDING_MISMATCH');
      }
      return receipt;
    };
    return { journalPath: flags.journalPath, promoted: build(bound, candidate, 'promoted'),
      ...(flags.rollbackDecision === 'approved' ? { rolled_back: build(candidate, bound, 'rolled_back') } : {}) };
  });
}

async function completeOperationalOutcome({ client, mode, approvalId, approval, envelope, consumeProof, result, report }) {
  const receipt = result.ok ? result.data?.promotionReceipt : null;
  let recorded;
  try {
    recorded = await client.recordOutcome(approvalId, { status: result.ok ? 'executed' : 'failed',
      receiptId: receipt?.receiptId || String(result.ok ? approvalId : result.error?.code || 'failed'),
      receiptHash: receipt?.receiptHash || null, consumeProof });
  } catch (error) { recorded = { status: 0, body: { code: error.code || 'AUTHORITY_UNAVAILABLE' } }; }
  if (recorded.status !== 200) return { code: 2, report: { ...report, outcomeRecorded: false,
    outcomeError: recorded.body?.code || `HTTP_${recorded.status}`,
    note: 'the action ran but the authority did not record its outcome; do not apply again before checking what happened' } };
  if (!receipt) return { code: result.ok ? 0 : 2, report };
  try {
    if (approval.tool !== 'terfi' || receipt.approvalId !== approvalId
        || receipt.workspaceId !== approval.workspaceId || receipt.actionHash !== approval.actionHash)
      refuse('PROMOTION_OUTCOME_BINDING_MISMATCH');
    const publicKey = mode.pin.signingKey;
    const decisionAttestation = buildApprovalDecisionAttestation({ decisionEnvelope: envelope,
      outcomeAttestation: recorded.body.attestation }, receipt, { publicKey });
    const stored = withJournal(result.data.journalPath, false, journal =>
      persistCoderPromotionReceipt({ journal, receipt, decisionAttestation, publicKey }));
    if (!stored.ok) refuse(stored.code);
    return { code: 0, report: { ...report, outcomeRecorded: true, promotionReceiptStored: true,
      decisionAttestationStored: true, promotionRunId: stored.runId } };
  } catch (error) {
    return { code: 2, report: { ...report, outcomeRecorded: true, promotionReceiptStored: false,
      receiptPending: true, receiptError: error.code || error.message } };
  }
}

async function recoverPromotionOutcome({ client, mode, approvalId, approval, envelope, consumeProof, loadInputs }) {
  const decision = envelope.payload.decision;
  const report = { approvalId, decision, alreadyFinal: approval.outcome.status };
  if (approval.tool !== 'terfi' || approval.outcome.status !== 'executed' || !approval.outcome.receiptHash)
    return { code: 0, report };
  try {
    const inputs = loadInputs(approval.arguments.argv);
    const plan = preparePromotionReceipt({ ...inputs,
      authority: { mode, approvalId, envelope, arguments: approval.arguments } });
    const receipt = [plan.promoted, plan.rolled_back].find(value =>
      value?.receiptHash === approval.outcome.receiptHash && value.receiptId === approval.outcome.receiptId);
    if (!receipt) refuse('PROMOTION_RECOVERY_HASH_MISMATCH');
    return completeOperationalOutcome({ client, mode, approvalId, approval, envelope, consumeProof,
      result: { ok: true, data: { promotionReceipt: receipt, journalPath: plan.journalPath } },
      report: { ...report, executed: false, recovered: true } });
  } catch (error) {
    return { code: 2, report: { ...report, receiptPending: true, receiptError: error.code || error.message } };
  }
}

module.exports = { preparePromotionReceipt, completeOperationalOutcome, recoverPromotionOutcome };

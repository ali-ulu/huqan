'use strict';

const path = require('node:path');
const { stableStringify } = require('../hash-chain');
const { canonicalActionHash } = require('../mcp-operator-capability');
const { verifyDecision } = require('../authority/decision-envelope');
const { buildApprovalDecisionAttestation } = require('../authority/decision-attestation');
const { openJournalConnection } = require('./journal-connection');
const { createExperienceJournal } = require('./journal');
const { resolveApprovalAuthorityMode } = require('../authority/authority-mode');
const { createAuthorityClient } = require('../authority/authority-client');
const { requireOperationalDecision } = require('../authority/operational-guard');
const { readCoderPromotionReceipt } = require('./coder-promotion-receipt');
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

const acceptanceTokens = new WeakMap();

function consumeCoderPromotionAcceptance(token, { workspaceId, capabilityId, procedureHash } = {}) {
  const binding = token && typeof token === 'object' ? acceptanceTokens.get(token) : null;
  if (!binding) return { ok: false, code: 'PROMOTION_ACCEPTANCE_REQUIRED' };
  acceptanceTokens.delete(token);
  if (!/^[0-9a-f]{64}$/.test(procedureHash || '') || binding.workspaceId !== workspaceId
      || binding.capabilityId !== capabilityId || binding.procedureHash !== procedureHash)
    return { ok: false, code: 'PROMOTION_ACCEPTANCE_BINDING_MISMATCH' };
  return { ok: true };
}

function freezeReceipt(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freezeReceipt(child);
  return Object.freeze(value);
}

async function requireCurrentPromotion(client, stored, workspaceId, capabilityId) {
  const head = await client.ledgerHead();
  const outcome = stored.decisionAttestation.outcomeAttestation.payload;
  let cursor = outcome.ledgerSeq;
  if (head.status !== 200 || !Number.isSafeInteger(head.body?.seq) || !Number.isSafeInteger(cursor)
      || cursor < 0 || head.body.seq < cursor || head.body.seq - cursor >= 10000)
    refuse('PROMOTION_HISTORY_UNAVAILABLE');
  while (cursor <= head.body.seq) {
    const page = await client.ledgerEntries({ fromSeq: cursor, limit: Math.min(500, head.body.seq - cursor + 1) });
    if (page.status !== 200 || page.body?.corrupt || !Array.isArray(page.body?.entries)
        || !page.body.entries.length) refuse('PROMOTION_HISTORY_UNAVAILABLE');
    for (const entry of page.body.entries) {
      if (entry.seq !== cursor++ || entry.seq > head.body.seq) refuse('PROMOTION_HISTORY_UNAVAILABLE');
      if (entry.seq === outcome.ledgerSeq) {
        if (entry.receiptHash !== outcome.ledgerHash || entry.type !== 'approval.outcome'
            || entry.body?.approvalId !== outcome.approvalId) refuse('PROMOTION_HISTORY_UNAVAILABLE');
        continue;
      }
      if (!['approval.consumed', 'approval.outcome'].includes(entry.type)) continue;
      const shown = await client.show(entry.body?.approvalId);
      const later = shown.body?.approval;
      if (shown.status !== 200 || !later) refuse('PROMOTION_HISTORY_UNAVAILABLE');
      if (later.tool !== 'terfi' || later.workspaceId !== workspaceId) continue;
      const argv = later.arguments?.argv;
      const index = Array.isArray(argv) ? argv.lastIndexOf('--capability') : -1;
      if (index < 0 || typeof argv[index + 1] !== 'string' || argv[index + 1].startsWith('--'))
        refuse('PROMOTION_HISTORY_UNAVAILABLE');
      if (argv[index + 1] === capabilityId) refuse('PROMOTION_ACCEPTANCE_SUPERSEDED');
    }
  }
  const after = await client.ledgerHead();
  if (after.status !== 200 || after.body?.seq !== head.body.seq || after.body?.hash !== head.body.hash)
    refuse('PROMOTION_HISTORY_CHANGED');
}

async function withCoderPromotionAcceptance({ journalPath, approvalId, workspaceId, capabilityId }, execute,
  { resolveMode = resolveApprovalAuthorityMode, createClient = createAuthorityClient } = {}) {
  const mode = resolveMode();
  if (mode?.mode !== 'service' || !mode.pin?.signingKey) refuse('PROMOTION_AUTHORITY_REQUIRED');
  const stored = withJournal(journalPath, true, journal => readCoderPromotionReceipt({ journal,
    approvalId, workspaceId, publicKey: mode.pin.signingKey, expected: { capabilityId } }));
  if (!stored.ok) refuse(stored.code);
  const client = createClient({ pin: mode.pin });
  const shown = await client.show(approvalId);
  const fetched = await client.getDecision(approvalId);
  const approval = shown.body?.approval;
  const current = fetched.body;
  const receipt = stored.receipt;
  if (shown.status !== 200 || fetched.status !== 200 || !approval || approval.status !== 'approved'
      || approval.withdrawn || current?.withdrawal || !approval.consumed
      || approval.approvalId !== approvalId || approval.workspaceId !== workspaceId
      || approval.tool !== 'terfi' || approval.actionHash !== receipt.actionHash
      || approval.outcome?.status !== 'executed' || approval.outcome.receiptId !== receipt.receiptId
      || approval.outcome.receiptHash !== receipt.receiptHash) refuse('PROMOTION_LIVE_BINDING_MISMATCH');
  const consumedAt = Date.parse(current?.consumption?.payload?.consumedAt);
  if (!Number.isFinite(consumedAt)) refuse('AUTHORITY_CONSUMPTION_REQUIRED');
  const verified = requireOperationalDecision({ mode, tool: 'terfi', workspaceId, args: approval.arguments,
    authority: { approvalId, envelope: current.envelope, consumption: current.consumption }, now: consumedAt });
  if (!verified.ok) refuse(verified.code);
  if (stableStringify(current.envelope) !== stableStringify(stored.decisionAttestation.decisionEnvelope))
    refuse('PROMOTION_LIVE_DECISION_MISMATCH');
  await requireCurrentPromotion(client, stored, workspaceId, capabilityId);
  const token = Object.freeze({});
  acceptanceTokens.set(token, { workspaceId, capabilityId, procedureHash: receipt.nextProcedure.hash });
  try {
    const result = execute(token, freezeReceipt(JSON.parse(stableStringify(receipt))));
    if (result && typeof result.then === 'function') refuse('PROMOTION_ACCEPTANCE_SYNC_REQUIRED');
    return result;
  } finally { acceptanceTokens.delete(token); }
}

module.exports = { preparePromotionReceipt, completeOperationalOutcome, recoverPromotionOutcome,
  withCoderPromotionAcceptance, consumeCoderPromotionAcceptance };

'use strict';

const { canonicalHash } = require('./bounded-exchange-values');
const { buildTrustEvidencePayload, verifyTrustEvidenceReceipt } = require('../trust-evidence-ledger');

function operationId(context, message, originalHash) {
  return `a2a-intervention:${canonicalHash({ workspaceId: context.workspaceId,
    sourceAgentId: context.sourceAgentId, exchangeId: message?.exchangeId || originalHash })}`;
}

async function writeInterventionReceipt(graph, context, record) {
  const payload = buildTrustEvidencePayload({
      operationId: record.operationId,
      workspaceId: context.workspaceId,
      decision: record.canonicalDecision,
      reason: record.reason,
      actionFingerprint: record.effectiveHash || record.originalHash,
      identityRef: `agent:${context.sourceAgentId}`,
      policyVersion: context.policyVersion,
      createdAt: context.now(),
      executionOutcome: record.outcome || 'not_dispatched',
      metadata: {
        surface: 'a2a-pre-dispatch',
        interventionDecision: record.decision,
        originalHash: record.originalHash,
        effectiveHash: record.effectiveHash || record.originalHash,
        preparedHash: record.preparedHash || null,
        sourceAgentId: context.sourceAgentId,
        targetAgentId: record.targetAgentId || null,
      },
  });
  // Await durability before exposing a dispatch reservation. Network I/O
  // must never run inside Graph's transaction.
  const result = await graph.runMutationOnce(record.operationId,
    () => ({ dispatchReserved: record.canonicalDecision === 'allow' }),
    { buildCanonicalReceipt: () => payload });
  const verification = verifyTrustEvidenceReceipt(result.receipt);
  if (!verification.valid) throw new Error('intervention_receipt_unverified');
  return Object.freeze({ ...result, verification });
}

module.exports = Object.freeze({ operationId, writeInterventionReceipt });

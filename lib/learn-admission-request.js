'use strict';

/**
 * The admission request a learn-shaped write is judged on.
 *
 * Lifted out of kernel.js rather than extended in place. #328's ratchet is
 * right about the reason: this is sixty lines deciding what the gate gets to
 * see, which is a responsibility of its own, and kernel.js is already one of
 * the files that may not grow. The behaviour is unchanged by the move -- only
 * the riskScore field below is new (#697).
 */

const { defaultApprovalRequired } = require('./human-approval-toggle');
const { admissionRiskFromConfidence } = require('./background-provenance');

// Defined here rather than imported: this repository keeps a local predicate
// per module instead of a shared utils grab-bag, and the extraction should not
// introduce a new cross-cutting dependency of its own.
const { isPlainObject } = require('./is-plain-object');

function buildLearnAdmissionRequest({ text, opts = {}, provenance = null, workspaceId = 'default', contractVersion }) {
  const admissionContext = isPlainObject(opts.admissionContext) ? opts.admissionContext : {};
  const createdAt =
    provenance?.timestamp ||
    opts.timestamp ||
    admissionContext.createdAt ||
    admissionContext.timestamp ||
    new Date().toISOString();
  const provenanceId =
    provenance?.provenanceId ||
    opts.provenanceId ||
    admissionContext.provenanceId ||
    `prov_${workspaceId}_${Date.now()}`;
  const actor =
    provenance?.actor ||
    opts.actor ||
    admissionContext.actor ||
    'kernel';
  const agentId =
    opts.agentId ||
    admissionContext.agentId ||
    'kernel';
  const memoryDraftId =
    opts.memoryDraftId ||
    admissionContext.memoryDraftId ||
    `draft_${provenanceId}`;
  const approvedAlready =
    (opts.approvalStatus || admissionContext.approvalStatus || '') === 'approved';
  const request = {
    ...admissionContext,
    workspaceId,
    actor,
    agentId,
    memoryDraftId,
    provenanceId,
    trustPolicyVersion:
      provenance?.trustPolicyVersion ||
      opts.trustPolicyVersion ||
      admissionContext.trustPolicyVersion ||
      contractVersion,
    approvalId: opts.approvalId || admissionContext.approvalId || '',
    approvalStatus: opts.approvalStatus || admissionContext.approvalStatus || '',
    approvalRequired: opts.approvalRequired ?? admissionContext.approvalRequired ?? defaultApprovalRequired(),
    reason: opts.admissionReason || admissionContext.reason || 'kernel_learn_write',
    // #697: the trust policy's confidence reaches the decision instead of
    // riding along as metadata. Set after the admissionContext spread so it
    // is the value the gate reads, and taken as a maximum so an explicit
    // risk a caller already computed is never lowered by a policy score.
    //
    // Not applied to a write that already carries an approval, because the
    // gate applies medium risk after approval handling and overrides `allow`
    // there: a policy score would otherwise send an explicitly approved write
    // back for review on the grounds of the source someone had just approved
    // it for. A caller's own riskScore still stands -- only the derived one
    // steps aside.
    riskScore: Math.max(
      Number(opts.riskScore ?? admissionContext.riskScore ?? 0) || 0,
      approvedAlready ? 0 : admissionRiskFromConfidence(provenance?.confidence),
    ),
    createdAt,
    proposedMemory: {
      content: String(text || ''),
      edges: [{ relation: 'learn', workspaceId }],
      metadata: {
        sourceType: provenance?.sourceType || opts.sourceType || admissionContext.sourceType || '',
        sourceRef: provenance?.sourceRef || opts.sourceRef || admissionContext.sourceRef || '',
        actor,
      },
    },
  };
  return request;
}

module.exports = { buildLearnAdmissionRequest };

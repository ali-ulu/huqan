'use strict';

function kernelContractVersion(approval) {
  return approval?.policy?.gate?.metadata?.contractVersion || 'mcp-approval';
}

function buildApprovalAdmissionOptions(approval, args = {}) {
  const approvalKey = approval.approvalKey || approval.approval_key || approval.id;
  const context = approval.context && typeof approval.context === 'object' ? approval.context : {};
  const candidate = context.candidate && typeof context.candidate === 'object' ? context.candidate : {};
  const candidateId = context.candidateId || context.memoryDraftId || candidate.candidateId || null;
  const workspaceId = context.workspaceId || candidate.workspaceId || args.workspaceId || 'default';
  const storedProvenance = context.provenance && typeof context.provenance === 'object'
    ? context.provenance
    : {};
  const provenanceId = storedProvenance.provenanceId || `prov_mcp_${approval.id}`;
  const provenance = {
    ...storedProvenance,
    provenanceId,
    sourceType: storedProvenance.sourceType || 'api',
    sourceSubType: storedProvenance.sourceSubType || 'mcp.learn',
    sourceRef: storedProvenance.sourceRef || approvalKey,
    sourceTitle: storedProvenance.sourceTitle || 'MCP learn approval',
    actor: storedProvenance.actor || 'mcp.learn',
    workspaceId,
    timestamp: storedProvenance.timestamp || new Date().toISOString(),
    trustPolicyVersion: kernelContractVersion(approval),
  };
  return {
    skipConflicts: args.skipConflicts !== false,
    maxSentences: args.maxSentences,
    workspaceId,
    memoryDraftId: candidateId || undefined,
    candidateId: candidateId || undefined,
    approvalRequired: true,
    approvalStatus: 'approved',
    approvalId: approval.id,
    provenanceId,
    sourceType: provenance.sourceType,
    sourceSubType: provenance.sourceSubType,
    sourceRef: provenance.sourceRef,
    actor: provenance.actor,
    provenance,
    admissionContext: {
      candidateId,
      memoryDraftId: candidateId,
      approvalId: approval.id,
      workspaceId,
      provenanceId,
      provenance,
    },
  };
}

module.exports = { buildApprovalAdmissionOptions };

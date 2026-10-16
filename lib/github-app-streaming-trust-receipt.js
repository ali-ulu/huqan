'use strict';

// #2167: evaluating the changed-file evidence and chaining the receipt onto
// the C7 receipt; the check conclusion and external id derive from it.

const { evaluateCodeChange } = require('./code-change-gate');
const { toCanonicalVerdict } = require('./verdict/action-verdict');
const { buildCanonicalReceiptPayload, sha256Hex, stableStringify } = require('./receipt/canonical-receipt');
const { appendReceiptToChain } = require('./receipt/receipt-chain');
const { canonicalInstantFromMs } = require('./github-app-streaming-trust-binding');
const { ERROR_CODES, RECEIPT_KIND, TRUST_POLICY_VERSION, fail } = require('./github-app-streaming-trust-contract');

function evaluateEvidence(binding, evidence) {
  return evaluateCodeChange({
    files: evidence.files,
    intent: 'github pull request changed files',
    operationType: 'preview',
    diffSummary: '',
    patchMetadata: {
      fileCount: evidence.fileCount,
      totalAdditions: evidence.totalAdditions,
      totalDeletions: evidence.totalDeletions,
    },
    repoState: {
      branch: `pull/${binding.pullRequestNumber}`,
      isMain: false,
      dirty: false,
      hasUntracked: false,
    },
    metadata: { workspaceId: 'default' },
  });
}

function evidenceDigest(binding, evidence) {
  return sha256Hex(stableStringify({
    repositoryId: binding.repositoryId,
    pullRequestNumber: binding.pullRequestNumber,
    headSha: binding.headSha,
    files: evidence.files,
    totalAdditions: evidence.totalAdditions,
    totalDeletions: evidence.totalDeletions,
  }));
}

function buildStreamingTrustReceipt({ binding, evidence, gate, nowMs }) {
  const verdict = toCanonicalVerdict('code_change', gate.decision);
  const evidenceSha256 = evidenceDigest(binding, evidence);
  const receiptId = `github_app_streaming_trust_${sha256Hex(`${binding.deliveryId}:${binding.headSha}:${evidenceSha256}`)}`;
  const createdAt = canonicalInstantFromMs(nowMs);
  const canonical = buildCanonicalReceiptPayload({
    receiptId,
    receiptKind: RECEIPT_KIND,
    decision: gate.decision,
    status: 'evaluated',
    admissionId: `github_app_streaming_trust:${binding.deliveryId}`,
    workspaceId: 'default',
    actor: `github-app:${binding.installationId}`,
    agentId: `github-app:${binding.installationId}`,
    provenanceId: `github-app-delivery:${binding.deliveryId}`,
    trustPolicyVersion: TRUST_POLICY_VERSION,
    approvalStatus: verdict === 'allow' ? 'approved' : 'pending',
    reason: gate.reason,
    riskScore: gate.risk && typeof gate.risk.score === 'number' ? gate.risk.score : 0,
    createdAt,
    metadata: {
      deliveryId: binding.deliveryId,
      repositoryId: binding.repositoryId,
      repositoryFullName: binding.repositoryFullName,
      installationId: binding.installationId,
      pullRequestNumber: binding.pullRequestNumber,
      headSha: binding.headSha,
      c7ReceiptHash: binding.c7ReceiptHash,
      evidenceSha256,
      fileCount: evidence.fileCount,
      totalAdditions: evidence.totalAdditions,
      totalDeletions: evidence.totalDeletions,
      riskLevel: gate.risk ? gate.risk.level : 'unknown',
      riskCategories: gate.risk && Array.isArray(gate.risk.categories) ? gate.risk.categories : [],
    },
  }, { verdict });
  return appendReceiptToChain(canonical, binding.c7ReceiptHash);
}

function checkConclusion(verdict) {
  if (verdict === 'allow') return 'success';
  if (verdict === 'review' || verdict === 'dry_run_only') return 'action_required';
  if (verdict === 'block') return 'failure';
  fail(ERROR_CODES.INVALID_INPUT, 'Streaming Trust verdict cannot be projected to a check conclusion');
}

function checkExternalId(binding, receipt) {
  return `huqan:c8:${sha256Hex(`${binding.deliveryId}:${receipt.receiptHash}`)}`;
}

module.exports = {
  buildStreamingTrustReceipt,
  // Re-exported so the declined check run hashes through this module: the
  // Core -> Application edge to receipt/canonical-receipt stays in one place.
  sha256Hex,
  checkConclusion,
  checkExternalId,
  evaluateEvidence,
  evidenceDigest,
};

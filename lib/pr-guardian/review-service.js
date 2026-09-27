'use strict';

const crypto = require('node:crypto');
const { evaluatePullRequest, ACTIONS, DECISIONS } = require('./policy');
const { normalizePullRequestSnapshot, sameTarget } = require('./snapshot');
const { projectApprovalRecord } = require('../mcp-approval-views');
const { createExecuteOnce } = require('./review-service-execute');

const TOOL = 'github.pr.guardian';

function text(value) {
  return typeof value === 'string' ? value.trim() : String(value == null ? '' : value).trim();
}

function nowMs() {
  return Date.now();
}

// Used only to derive a deterministic approval id from its approvalKey --
// unrelated to review-receipt.js's own sha256, which hashes receipt/result
// content. Kept separate rather than shared so the two call sites do not
// couple on a "the same digest helper" assumption neither one needs.
function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function publicApproval(record) {
  return projectApprovalRecord(record);
}

function createReviewService({ storage, kernel = null, getCurrentSnapshot = null, now = nowMs } = {}) {
  if (!storage || typeof storage.saveToolApprovalIfAbsent !== 'function') {
    throw new TypeError('storage with saveToolApprovalIfAbsent is required');
  }

  function list(limit = 50, workspaceId = 'default') {
    const rows = typeof storage.listUnresolvedToolApprovals === 'function'
      ? storage.listUnresolvedToolApprovals(Math.min(100, Math.max(1, Number(limit) || 50)), text(workspaceId) || 'default')
      : [];
    return rows.filter(row => row.tool === TOOL).map(publicApproval);
  }

  function get(id, workspaceId = 'default') {
    if (typeof storage.getToolApprovalById !== 'function') return null;
    const row = storage.getToolApprovalById(id, text(workspaceId) || 'default');
    return row && row.tool === TOOL ? publicApproval(row) : null;
  }

  function enqueue(snapshotInput, { action = ACTIONS.COMMENT_CREATE, requestedBy = 'github-webhook' } = {}) {
    const snapshot = normalizePullRequestSnapshot(snapshotInput);
    const policy = evaluatePullRequest(snapshot, { action, phase: 'preview' });
    const approvalKey = `${TOOL}|${snapshot.workspaceId}|${snapshot.repo}|${snapshot.number}|${snapshot.headSha}|${action}`;
    const saved = storage.saveToolApprovalIfAbsent({
      id: `ghapproval_${sha256(approvalKey).slice(0, 24)}`,
      approvalKey,
      tool: TOOL,
      input: JSON.stringify({ action, repo: snapshot.repo, number: snapshot.number, headSha: snapshot.headSha }),
      status: policy.decision === DECISIONS.BLOCK ? 'rejected' : 'pending',
      decision: policy.decision,
      reason: policy.reason,
      context: {
        source: 'github-pr-guardian',
        requestedBy,
        snapshot,
        action,
        targetHash: snapshot.targetHash,
        provenance: snapshot.provenance,
        riskLabels: policy.riskLabels,
      },
      policy,
    });
    const approval = saved.approval;
    return {
      ok: policy.decision !== DECISIONS.BLOCK,
      idempotent: !saved.inserted,
      decision: policy.decision,
      policy,
      approval: approval ? publicApproval(approval) : null,
      snapshot,
    };
  }

  function decide(id, decision, reason = '', workspaceId = 'default') {
    const scopedWorkspaceId = text(workspaceId) || 'default';
    const record = storage.getToolApprovalById(id, scopedWorkspaceId);
    if (!record || record.tool !== TOOL) return { ok: false, status: 404, code: 'PR_APPROVAL_NOT_FOUND' };
    if (!['approved', 'rejected'].includes(decision)) return { ok: false, status: 400, code: 'PR_DECISION_INVALID' };
    const updated = decision === 'approved'
      ? storage.resolveToolApproval(id, 'approved', reason || 'operator_approved', scopedWorkspaceId)
      : storage.rejectToolApproval(id, reason || 'operator_rejected', scopedWorkspaceId);
    return {
      ok: true,
      decision,
      approval: updated ? publicApproval(updated) : null,
    };
  }

  // The once-only GitHub execution step (#1675) lives in
  // review-service-execute.js; its body moved verbatim there (#2280) and
  // binds the same storage seam, live snapshot source and clock.
  const execute = createExecuteOnce({ storage, getCurrentSnapshot, now });

  function dryRun(snapshotInput, { action = ACTIONS.STATUS_PREVIEW } = {}) {
    const snapshot = normalizePullRequestSnapshot(snapshotInput);
    const policy = evaluatePullRequest(snapshot, { action, phase: 'preview' });
    return { ok: true, dryRun: true, decision: policy.decision, policy, snapshot, canonicalWrite: false };
  }

  return Object.freeze({ list, get, enqueue, decide, execute, dryRun });
}

module.exports = Object.freeze({
  TOOL,
  createReviewService,
});

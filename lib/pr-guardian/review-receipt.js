'use strict';

/**
 * Builds the execution receipt for a PR Guardian action. Split out of
 * lib/pr-guardian/review-service.js (#2280): that file owns the approval
 * state machine (list/get/enqueue/decide/execute), this one owns turning
 * a completed (or failed) execution into the receipt shape stored on the
 * approval record and returned to the caller.
 */

const crypto = require('node:crypto');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function safeJson(value) {
  try { return JSON.stringify(value); } catch (_) { return '{}'; }
}

function makeReceipt({ approval, snapshot, action, outcome, result = null, error = null }) {
  const issuedAt = new Date().toISOString();
  const receiptId = `ghreceipt_${sha256(`${approval.id}|${snapshot.targetHash}|${action}|${outcome}|${issuedAt}`).slice(0, 24)}`;
  return Object.freeze({
    receiptId,
    type: 'huqan.github.pr.guardian.execution',
    version: '1.0.0',
    approvalId: approval.id,
    workspaceId: snapshot.workspaceId,
    repo: snapshot.repo,
    pullRequest: snapshot.number,
    headSha: snapshot.headSha,
    targetHash: snapshot.targetHash,
    action,
    outcome,
    issuedAt,
    resultHash: result == null ? null : `sha256:${sha256(safeJson(result))}`,
    errorCode: error?.code || null,
    canonicalWrite: false,
  });
}

module.exports = { makeReceipt };

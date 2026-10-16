'use strict';

/**
 * Audit write for human review verdicts (#2345).
 *
 * Kernel exposes no public audit append (pinned by kernel-facade-contract),
 * and reaching `kernel._appendAuditEvent` from hypothesis-review.js was that
 * file's recorded cross-module private call -- so the call goes to the public
 * `kernel.graph.appendAuditEvent` here instead, with the same null-safe,
 * swallow-and-null contract, and a kernel without a graph simply records
 * nothing. Single purpose: this module exists so the audit write has a named
 * home distinct from the review verdict logic.
 */

function appendReviewAuditEvent(kernel, event, provenance, workspaceId) {
  if (!kernel || !kernel.graph || typeof kernel.graph.appendAuditEvent !== 'function') return null;
  try {
    return kernel.graph.appendAuditEvent(event, provenance ? { provenance, workspaceId } : { workspaceId });
  } catch (error) {
    console.error('[hypothesis-review] Audit log error:', error && error.message ? error.message : error);
    return null;
  }
}

module.exports = { appendReviewAuditEvent };

'use strict';

// The approval authority's view of every approval, derived from its ledger
// (#3860, ADR-016 item 8). The ledger is the source of truth; this view is the
// only way the service learns an approval's state, at start and after each
// append, so it can never say something the ledger does not. Each entry
// replaces one frozen record, so an append costs the same however long the
// ledger has grown.
//
// Part of the authority bundle (lib/authority/bundle-manifest.js).

function registered(entry) {
  const { approvalId, workspaceId, tool, arguments: args, actionHash, consumeProofHash, summary, expiresAt } = entry.body;
  return { approvalId, workspaceId, tool, arguments: args, actionHash, consumeProofHash, summary, expiresAt,
    registeredAt: entry.at, status: 'pending', decision: null, consumed: null, outcome: null };
}

const REDUCERS = Object.freeze({
  'approval.registered': (current, entry) => (current ? null : registered(entry)),
  'approval.decided': (current, entry) => ({ ...current, status: entry.body.decision,
    decision: { ...entry.body, ledgerSeq: entry.seq, ledgerHash: entry.receiptHash } }),
  'approval.consumed': (current, entry) => ({ ...current,
    consumed: { at: entry.at, ledgerSeq: entry.seq, ledgerHash: entry.receiptHash } }),
  'approval.outcome': (current, entry) => ({ ...current, outcome: { ...entry.body, at: entry.at } }),
});

function createApprovalView(entries = []) {
  const approvals = new Map();

  /** Fold one ledger entry in. Entries that name no known approval change nothing. */
  function apply(entry) {
    const reduce = REDUCERS[entry.type];
    const approvalId = entry.body && entry.body.approvalId;
    const current = approvals.get(approvalId);
    if (!reduce || (entry.type !== 'approval.registered' && !current)) return;
    const next = reduce(current, entry);
    if (next) approvals.set(approvalId, Object.freeze(next));
  }

  entries.forEach(apply);
  return { apply, get: approvalId => approvals.get(approvalId), values: () => approvals.values() };
}

/**
 * The listing projection. Arguments are left out for size, not secrecy: the
 * runtime that registered them runs as the same OS user as every other local
 * caller and already holds them in its own store.
 */
function summarize(approval) {
  const { arguments: _args, consumeProofHash: _proof, ...rest } = approval;
  return rest;
}

module.exports = { createApprovalView, summarize };

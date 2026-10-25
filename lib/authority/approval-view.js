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
  const { approvalId, workspaceId, tool, arguments: args, actionHash, consumeProofHash, summary, expiresAt, requesterId, eligibleApprovers } = entry.body;
  return { approvalId, workspaceId, tool, arguments: args, actionHash, consumeProofHash, summary, expiresAt,
    ...(requesterId ? { requesterId } : {}),
    ...(eligibleApprovers ? { eligibleApprovers } : {}),
    registeredAt: entry.at, status: 'pending', decision: null, votes: [], consumed: null, outcome: null };
}

const REDUCERS = Object.freeze({
  'approval.registered': (current, entry) => (current ? null : registered(entry)),
  'approval.vote': (current, entry) => ({ ...current, votes: [...(current.votes || []), {
    ...entry.body, ledgerSeq: entry.seq, ledgerHash: entry.receiptHash,
  }] }),
  'approval.decided': (current, entry) => ({ ...current, status: entry.body.decision,
    decision: { ...entry.body, ledgerSeq: entry.seq, ledgerHash: entry.receiptHash } }),
  'approval.withdrawn': (current, entry) => ({ ...current, status: 'withdrawn',
    withdrawn: { ...entry.body, ledgerSeq: entry.seq, ledgerHash: entry.receiptHash } }),
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

/**
 * #4215: the durable record of one quorum vote. It names the approval it is
 * bound to, the workspace/tool/action it authorizes, the operator and the
 * method that authenticated it, and the policy that required the threshold at
 * the time. The policy is a hash, never the credential itself.
 */
function quorumVote({ approval, identity, request, votedAt, quorumRequired, fingerprint }) {
  return { approvalId: approval.approvalId, workspaceId: approval.workspaceId, tool: approval.tool,
    actionHash: approval.actionHash, operatorId: identity.operatorId, decision: request.decision,
    reason: request.reason, votedAt, quorumRequired, authMethod: identity.source, ...fingerprint };
}

/** A second vote is idempotent when it repeats the decision already recorded. */
function repeatVote(priorVote, decision) {
  return priorVote.decision === decision ? 'idempotent' : 'conflict';
}

/**
 * The distinct approvers so far and how far they are from the threshold.
 * When `eligibleApprovers` is present on the approval, only votes cast by
 * those operators count toward quorum; every other vote is ignored for
 * progress. When no eligible list is present, every distinct approved voter
 * counts (the pre-#4215 behavior).
 */
function quorumProgress(votes, required, eligibleApprovers) {
  const approvedVoterIds = new Set(votes.filter(vote => vote.decision === 'approved').map(vote => vote.operatorId));
  const eligible = Array.isArray(eligibleApprovers) ? eligibleApprovers : null;
  const approverIds = eligible === null
    ? [...approvedVoterIds]
    : eligible.filter(id => approvedVoterIds.has(id));
  return { required, received: approverIds.length, approverIds };
}

/**
 * The quorum a crash may have completed just before the separate decision
 * entry was appended: a recorded rejection, or enough distinct eligible
 * approvals. Returns null when the quorum cannot yet be determined, including
 * when the threshold exceeds the number of eligible voters (it can never be
 * satisfied).
 */
function completedQuorum(votes, quorumRequired, eligibleApprovers) {
  const eligible = Array.isArray(eligibleApprovers) ? eligibleApprovers : null;
  if (eligible !== null && eligible.length > 0 && quorumRequired > eligible.length) return null;
  const vetoVote = [...votes].reverse().find(vote => vote.decision === 'rejected');
  const { approverIds } = quorumProgress(votes, quorumRequired, eligible);
  if (!vetoVote && approverIds.length < quorumRequired) return null;
  const finalVote = vetoVote || [...votes].reverse().find(vote => vote.decision === 'approved');
  return { decision: vetoVote ? 'rejected' : 'approved', finalVote, approverIds };
}

/** A vote from before #4215 carries no policy; fall back to the one in force now. */
function voteFingerprint(vote, fallback) {
  return Number.isInteger(vote?.policyVersion) && typeof vote.policyHash === 'string'
    ? { policyVersion: vote.policyVersion, policyHash: vote.policyHash }
    : fallback;
}

module.exports = {
  createApprovalView, summarize, quorumVote, repeatVote, voteFingerprint, quorumProgress, completedQuorum,
};

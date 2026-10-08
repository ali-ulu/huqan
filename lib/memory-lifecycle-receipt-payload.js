'use strict';

// The canonical payloads a memory-lifecycle chain commits to, split out of
// lib/memory-lifecycle.js (#3619) so the entry stays under its line budget.
// R54 (#3619): each payload includes the receipt's rule identity, so a chain
// commits to which rule version produced each decision and a rule that changed
// version mid-chain breaks the binding. The identity itself lives at
// metadata.ruleIdentity on the built receipt (the hashed, additive home); these
// builders read it back with `readReceiptRuleIdentity`.

const { readReceiptRuleIdentity } = require('./receipt-rule-identity');

function trimText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** The canonical payload a chained admission receipt commits to. */
function receiptChainPayload(receipt = {}) {
  const identity = readReceiptRuleIdentity(receipt) || {};
  return {
    receiptId: trimText(receipt.receiptId),
    admissionId: trimText(receipt.admissionId),
    workspaceId: trimText(receipt.workspaceId),
    decision: trimText(receipt.decision),
    memoryDraftId: trimText(receipt.memoryDraftId),
    ruleId: trimText(identity.ruleId),
    instanceId: trimText(identity.instanceId),
    policyVersion: trimText(identity.policyVersion),
    createdAt: trimText(receipt.createdAt),
  };
}

/** The canonical payload a chained tombstone/supersede receipt commits to. */
function lifecycleReceiptPayload(receipt = {}) {
  return {
    receiptId: trimText(receipt.receiptId),
    action: trimText(receipt.action),
    memoryId: trimText(receipt.memoryId),
    newMemoryId: trimText(receipt.newMemoryId),
    workspaceId: trimText(receipt.workspaceId),
    actor: trimText(receipt.actor),
    // `reason` and `eventId` are hashed too: both are part of what the receipt
    // asserts, so a tampered reason or swapped event id must break the chain,
    // exactly as a changed action would.
    reason: trimText(receipt.reason),
    eventId: trimText(receipt.eventId),
    ruleId: trimText(receipt.ruleId),
    instanceId: trimText(receipt.instanceId),
    policyVersion: trimText(receipt.policyVersion),
    createdAt: trimText(receipt.createdAt),
  };
}

module.exports = { receiptChainPayload, lifecycleReceiptPayload };

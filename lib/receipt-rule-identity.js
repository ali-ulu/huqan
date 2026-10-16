'use strict';

/**
 * R54 (#3619) — rule identity on gate receipts.
 *
 * A receipt says what was decided, but not which rule version decided it. When
 * a policy changes, a chain of receipts from before and after look identical in
 * shape: nothing on a receipt lets an auditor say "this verdict came from rule
 * X at version V". This module carries that identity — `policyVersion`,
 * `ruleId`, `instanceId` — on a receipt's `metadata.ruleIdentity`, which the
 * receipt hash already covers. A rule version is therefore provable after the
 * fact and a chain can refuse a receipt whose rule identity is missing or whose
 * rule changed version mid-chain.
 *
 * The identity lives in `metadata` on purpose. ADR-009 freezes the v1 canonical
 * schema byte-for-byte: adding a top-level canonical field would change every
 * existing receipt's hash and break successor linkage. `metadata` is the
 * sanctioned additive home for new hashed fields (see the declared-confidence
 * and expiry fields in memory-admission-gate-receipt.js), so this adds evidence
 * without rewriting historical receipts.
 *
 * The identity is bounded: rule ids and versions are short machine-written
 * tokens, so a misbehaving caller cannot inflate every receipt with free text.
 */

const crypto = require('node:crypto');

const RECEIPT_RULE_IDENTITY_LIMIT = 128;

// Chain-level reasons, distinct from the generic content/link reasons: an
// auditor needs to tell "the receipt was tampered" from "the receipt cannot say
// which rule produced it" and from "the rule changed version inside the chain".
const RULE_IDENTITY_CHAIN_REASONS = Object.freeze({
  MISSING_RULE_IDENTITY: 'missing_rule_identity',
  RULE_VERSION_CHANGED: 'rule_version_changed',
});

function ruleIdentityText(value) {
  return typeof value === 'string' ? value.trim().slice(0, RECEIPT_RULE_IDENTITY_LIMIT) : '';
}

/**
 * Normalize a rule identity to its three bounded text fields. Absent fields
 * become the empty string, so the shape is stable and the caller can tell an
 * unset identity (`hasRuleIdentity` false) from a malformed one.
 */
function receiptRuleIdentity(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    policyVersion: ruleIdentityText(source.policyVersion),
    ruleId: ruleIdentityText(source.ruleId),
    instanceId: ruleIdentityText(source.instanceId),
  };
}

/** Whether an identity names a rule and a version: the two fields a chain binds. */
function hasRuleIdentity(identity) {
  const normalized = receiptRuleIdentity(identity);
  return Boolean(normalized.policyVersion && normalized.ruleId);
}

/**
 * Read the rule identity a receipt carries. It lives at `metadata.ruleIdentity`
 * on a built receipt, but a projected / flattened record may carry the three
 * fields at its top level, so both are accepted.
 */
function readReceiptRuleIdentity(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.metadata && typeof record.metadata === 'object'
    && record.metadata.ruleIdentity && typeof record.metadata.ruleIdentity === 'object') {
    return receiptRuleIdentity(record.metadata.ruleIdentity);
  }
  return receiptRuleIdentity(record);
}

/**
 * Attach a bounded rule identity to a receipt's metadata, returning the receipt.
 * The identity is nested under `ruleIdentity` so it cannot collide with any
 * other metadata key, and it is created if absent.
 */
function attachReceiptRuleIdentity(receipt, identity) {
  if (!receipt || typeof receipt !== 'object') {
    throw new TypeError('attachReceiptRuleIdentity requires a receipt object');
  }
  const normalized = assertReceiptRuleIdentity(identity);
  const metadata = receipt.metadata && typeof receipt.metadata === 'object' ? receipt.metadata : {};
  metadata.ruleIdentity = normalized;
  receipt.metadata = metadata;
  return receipt;
}

/**
 * Fail-closed on an identity that cannot name the rule that decided: a receipt
 * without a rule version is not evidence about any rule.
 */
function assertReceiptRuleIdentity(identity) {
  if (!identity || typeof identity !== 'object') {
    throw new TypeError('receipt rule identity is required');
  }
  const normalized = receiptRuleIdentity(identity);
  if (!normalized.policyVersion) {
    throw new TypeError('receipt rule identity requires policyVersion');
  }
  if (!normalized.ruleId) {
    throw new TypeError('receipt rule identity requires ruleId');
  }
  return normalized;
}

/**
 * A short, stable fingerprint of the identity. Enough to name which rule
 * version decided in a log line or a corrective action, not to reconstruct it.
 */
function ruleIdentityFingerprint(identity) {
  const normalized = receiptRuleIdentity(identity);
  return crypto.createHash('sha256')
    .update(`${normalized.policyVersion}|${normalized.ruleId}|${normalized.instanceId}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

/**
 * Bind a rule identity across a chain of records. Each record must carry a
 * `ruleIdentity`, and every record must carry the policy version the first one
 * did. The binding is chain-wide rather than per `ruleId`: on the
 * external-action path `ruleId` is the decision reason, so a version change
 * usually arrives under a new rule id and a per-rule map would let it through.
 * A receipt that omits its identity, or that silently adopts a new policy
 * version mid-chain, is rejected at the offending index rather than passed as
 * consistent.
 *
 * The generic hash/link validation stays in lib/hash-chain.js; this is the
 * receipt-chain's own version binding, layered on top (see receipt-chain.js).
 */
function validateRuleIdentityChain(records) {
  if (!Array.isArray(records)) {
    throw new TypeError('validateRuleIdentityChain requires an array of chained receipts');
  }
  let chainPolicyVersion = null;
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    // A built receipt carries the identity nested at metadata.ruleIdentity; a
    // projected/flattened record may carry the three fields at its top level.
    // `readReceiptRuleIdentity` accepts both shapes.
    const identity = readReceiptRuleIdentity(record) || receiptRuleIdentity({});
    if (!identity.policyVersion || !identity.ruleId) {
      return { valid: false, brokenAt: i, reason: RULE_IDENTITY_CHAIN_REASONS.MISSING_RULE_IDENTITY };
    }
    if (chainPolicyVersion === null) {
      chainPolicyVersion = identity.policyVersion;
    } else if (chainPolicyVersion !== identity.policyVersion) {
      return { valid: false, brokenAt: i, reason: RULE_IDENTITY_CHAIN_REASONS.RULE_VERSION_CHANGED };
    }
  }
  return { valid: true, brokenAt: null, reason: null };
}

module.exports = {
  RECEIPT_RULE_IDENTITY_LIMIT,
  RULE_IDENTITY_CHAIN_REASONS,
  ruleIdentityText,
  receiptRuleIdentity,
  hasRuleIdentity,
  readReceiptRuleIdentity,
  attachReceiptRuleIdentity,
  assertReceiptRuleIdentity,
  ruleIdentityFingerprint,
  validateRuleIdentityChain,
};

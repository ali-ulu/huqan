'use strict';

/**
 * V4-PR2.5 — Trust Receipt Primitive Hardening: canonical receipt payload.
 *
 * This module does NOT change lib/memory-admission-gate.js's existing
 * buildMemoryAdmissionReceipt() output — it is purely additive. It consumes
 * that existing receipt shape (or an equivalent MCP-side receipt in the
 * future) and projects it into a fixed, versioned, deterministically
 * serializable payload suitable for hashing and chaining.
 *
 * The canonical `verdict` field is sourced from PR2's
 * lib/verdict/action-verdict.js — this module does not re-implement or
 * duplicate that mapping table.
 */

const crypto = require('crypto');
const { CANONICAL_VERDICTS } = require('../verdict/action-verdict');

const CANONICAL_RECEIPT_SCHEMA_VERSION = 'v4-receipt-v1';

const CANONICAL_VERDICT_SET = new Set(CANONICAL_VERDICTS);

/**
 * Deterministic JSON serialization: object keys are sorted recursively so the
 * same logical payload always serializes to the exact same string, regardless
 * of property insertion order. Arrays preserve their original order (order is
 * semantically meaningful for arrays, not for object keys).
 */
function stableStringify(value) {
  return JSON.stringify(sortForStableStringify(value));
}

function sortForStableStringify(value) {
  if (Array.isArray(value)) {
    return value.map(sortForStableStringify);
  }
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortForStableStringify(value[key]);
    }
    return sorted;
  }
  return value;
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Build the fixed, versioned canonical receipt payload from an existing
 * receipt object (e.g. the output of buildMemoryAdmissionReceipt()).
 *
 * `verdict` must be an explicit, already-reconciled canonical verdict string
 * (from lib/verdict/action-verdict.js) — this function does not infer or
 * derive it, to avoid creating a second, drifting copy of PR2's mapping.
 */
function buildCanonicalReceiptPayload(receipt, opts = {}) {
  if (!receipt || typeof receipt !== 'object') {
    throw new TypeError('buildCanonicalReceiptPayload requires an existing receipt object');
  }
  const verdict = opts.verdict;
  if (!CANONICAL_VERDICT_SET.has(verdict)) {
    throw new TypeError(`buildCanonicalReceiptPayload requires opts.verdict to be a canonical verdict (got: ${JSON.stringify(verdict)}). Derive it via lib/verdict/action-verdict.js, do not guess it here.`);
  }

  return {
    schemaVersion: CANONICAL_RECEIPT_SCHEMA_VERSION,
    receiptId: String(receipt.receiptId || ''),
    receiptKind: String(receipt.receiptKind || ''),
    decision: String(receipt.decision || ''),
    verdict,
    status: String(receipt.status || ''),
    admissionId: String(receipt.admissionId || ''),
    workspaceId: String(receipt.workspaceId || 'default'),
    actor: String(receipt.actor || ''),
    agentId: String(receipt.agentId || ''),
    memoryDraftId: String(receipt.memoryDraftId || ''),
    provenanceId: String(receipt.provenanceId || ''),
    trustPolicyVersion: String(receipt.trustPolicyVersion || ''),
    approvalId: String(receipt.approvalId || ''),
    approvalStatus: String(receipt.approvalStatus || ''),
    reason: String(receipt.reason || ''),
    riskScore: typeof receipt.riskScore === 'number' ? receipt.riskScore : 0,
    createdAt: String(receipt.createdAt || ''),
    metadata: receipt.metadata && typeof receipt.metadata === 'object' ? JSON.parse(JSON.stringify(receipt.metadata)) : {},
  };
}

/** Hash a canonical receipt payload (deterministic: same payload -> same hash, always). */
function hashCanonicalReceiptPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new TypeError('hashCanonicalReceiptPayload requires a canonical receipt payload');
  }
  return sha256Hex(stableStringify(payload));
}

module.exports = {
  CANONICAL_RECEIPT_SCHEMA_VERSION,
  stableStringify,
  sha256Hex,
  buildCanonicalReceiptPayload,
  hashCanonicalReceiptPayload,
};

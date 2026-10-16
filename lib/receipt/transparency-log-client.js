'use strict';

/**
 * Rekor-style transparency-log client (#3608).
 *
 * policy-seal.js verifies the transparency reference as shape only. This
 * module adds the real client: fetch the inclusion proof for a sealed
 * entry and verify it, fail-closed. No proof returned means no verified
 * transparency -- never a silent pass.
 *
 * Pure verifier with injected fetch: the caller supplies `fetchProof`, so
 * this module does no I/O policy of its own and stays testable without a
 * network. The proof shape is the minimal Rekor-style contract:
 * `{ logIndex, treeSize, rootHash, hashes, checkpoints }` where `hashes`
 * is the audit path from leaf to root.
 */

const crypto = require('node:crypto');

function fail(reason, extra = {}) {
  return Object.freeze({ ok: false, reason, ...extra });
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Verify one inclusion proof against the expected leaf hash.
 * `proof` must carry a non-empty `hashes` audit path and a `rootHash`;
 * the recomputed root must equal `rootHash`. Anything else fails closed.
 */
function verifyInclusionProof(leafHash, proof) {
  if (!isNonEmptyString(leafHash)) return fail('inclusion_leaf_missing');
  if (!proof || typeof proof !== 'object') return fail('inclusion_proof_missing');
  if (!isNonEmptyString(proof.rootHash)) return fail('inclusion_proof_missing');
  if (!Array.isArray(proof.hashes) || proof.hashes.length === 0) return fail('inclusion_proof_missing');
  if (proof.hashes.some((h) => !isNonEmptyString(h))) return fail('inclusion_proof_malformed');
  let current = leafHash;
  for (const sibling of proof.hashes) {
    current = sha256Hex(current + sibling);
  }
  if (current !== proof.rootHash) return fail('inclusion_proof_mismatch', { rootHash: proof.rootHash });
  return Object.freeze({ ok: true, reason: '', rootHash: proof.rootHash, logIndex: proof.logIndex ?? null });
}

/**
 * Fetch and verify the inclusion proof for a sealed transparency entry.
 * `fetchProof` is `async ({ log, leafIndex }) => proof | null`. A null or
 * malformed proof fails closed with `inclusion_proof_missing` or the
 * verifier's reason -- never passes.
 */
async function verifyTransparencyEntry({ log, leafIndex, leafHash } = {}, { fetchProof } = {}) {
  if (!isNonEmptyString(log)) return fail('transparency_log_missing');
  if (leafIndex === undefined || leafIndex === null) return fail('transparency_leaf_missing');
  if (typeof fetchProof !== 'function') return fail('transparency_client_missing');
  let proof;
  try {
    proof = await fetchProof({ log, leafIndex });
  } catch (_) {
    return fail('transparency_fetch_failed', { log });
  }
  if (!proof) return fail('inclusion_proof_missing', { log });
  return verifyInclusionProof(leafHash, proof);
}

module.exports = Object.freeze({ verifyInclusionProof, verifyTransparencyEntry });

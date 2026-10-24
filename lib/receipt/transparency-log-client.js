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
 * The signed statement a checkpoint attests: the log's identity, its size at
 * signing time, and the Merkle root over that size. Canonicalized so the same
 * checkpoint verifies regardless of key order.
 */
function canonicalCheckpointPayload(checkpoint) {
  return JSON.stringify({
    log: String(checkpoint?.log || ''),
    treeSize: Number(checkpoint?.treeSize),
    rootHash: String(checkpoint?.rootHash || ''),
  });
}

/**
 * Verify a signed transparency-log checkpoint (#4220).
 *
 * A checkpoint is the log's signed commitment to `{ log, treeSize, rootHash }`.
 * The signature is ed25519 over the canonical payload, produced by the log's
 * private key; the caller supplies the public key it trusts for that log. This
 * is the anchor an inclusion proof needs: without it, `rootHash` is just
 * another attacker-supplied field.
 *
 * Fail-closed: no checkpoint, no key, no expected log, a checkpoint naming any
 * other log (or none), or a bad signature all refuse.
 */
function verifyTransparencyCheckpoint(checkpoint, { log = '', logPublicKeyPem = '' } = {}) {
  if (!checkpoint || typeof checkpoint !== 'object') return fail('checkpoint_missing');
  if (!isNonEmptyString(checkpoint.rootHash)) return fail('checkpoint_missing');
  if (!Number.isSafeInteger(checkpoint.treeSize) || checkpoint.treeSize < 0) return fail('checkpoint_malformed');
  if (!isNonEmptyString(checkpoint.signature)) return fail('checkpoint_unsigned');
  if (!isNonEmptyString(logPublicKeyPem)) return fail('checkpoint_key_missing');
  if (!isNonEmptyString(log)) return fail('checkpoint_log_missing');
  if (checkpoint.log !== log) return fail('checkpoint_log_mismatch', { log: checkpoint.log });
  let key;
  try {
    key = crypto.createPublicKey(logPublicKeyPem);
  } catch (_) {
    return fail('checkpoint_key_invalid');
  }
  let verified = false;
  try {
    verified = crypto.verify(
      null,
      Buffer.from(canonicalCheckpointPayload(checkpoint), 'utf8'),
      key,
      Buffer.from(checkpoint.signature, 'base64'),
    );
  } catch (_) {
    return fail('checkpoint_signature_invalid');
  }
  if (!verified) return fail('checkpoint_signature_invalid');
  return Object.freeze({
    ok: true,
    reason: '',
    log,
    treeSize: checkpoint.treeSize,
    rootHash: checkpoint.rootHash,
  });
}

/**
 * Verify one inclusion proof against the expected leaf hash and a trusted,
 * signed checkpoint (#4220).
 *
 * A proof that only checks `rootHash` against itself proves nothing: the
 * attacker supplies both the audit path and the root, so any leaf can be made
 * to "verify" against a root that was never logged. Inclusion is only
 * meaningful relative to a root the log signed. The caller therefore supplies
 * a `checkpoint` — the log's signed statement of `{ log, treeSize, rootHash }`
 * — and the `logPublicKeyPem` it trusts for that log, resolved out of band.
 *
 * Fail-closed: a missing or unverifiable checkpoint refuses the proof. A proof
 * whose `rootHash`/`treeSize` disagree with the signed checkpoint is refused,
 * and the leaf→root path is recomputed against the *checkpoint's* root, never
 * the proof's.
 */
function verifyInclusionProof(leafHash, proof, { checkpoint = null, log = '', logPublicKeyPem = '' } = {}) {
  if (!isNonEmptyString(leafHash)) return fail('inclusion_leaf_missing');
  if (!proof || typeof proof !== 'object') return fail('inclusion_proof_missing');
  if (!isNonEmptyString(proof.rootHash)) return fail('inclusion_proof_missing');
  if (!Array.isArray(proof.hashes) || proof.hashes.length === 0) return fail('inclusion_proof_missing');
  if (proof.hashes.some((h) => !isNonEmptyString(h))) return fail('inclusion_proof_malformed');

  const verifiedCheckpoint = verifyTransparencyCheckpoint(checkpoint, { log, logPublicKeyPem });
  if (!verifiedCheckpoint.ok) return verifiedCheckpoint;

  if (proof.rootHash !== verifiedCheckpoint.rootHash) {
    return fail('inclusion_root_not_checkpointed', { rootHash: proof.rootHash, checkpointRoot: verifiedCheckpoint.rootHash });
  }
  if (proof.treeSize !== undefined && proof.treeSize !== null
      && Number(proof.treeSize) !== verifiedCheckpoint.treeSize) {
    return fail('inclusion_tree_size_mismatch', { treeSize: proof.treeSize, checkpointTreeSize: verifiedCheckpoint.treeSize });
  }

  let current = leafHash;
  for (const sibling of proof.hashes) {
    current = sha256Hex(current + sibling);
  }
  if (current !== verifiedCheckpoint.rootHash) {
    return fail('inclusion_proof_mismatch', { rootHash: verifiedCheckpoint.rootHash });
  }
  return Object.freeze({
    ok: true,
    reason: '',
    rootHash: verifiedCheckpoint.rootHash,
    treeSize: verifiedCheckpoint.treeSize,
  });
}

/**
 * Fetch and verify the inclusion proof for a sealed transparency entry.
 * `fetchProof` is `async ({ log, leafIndex }) => proof | null`. A null or
 * malformed proof fails closed with `inclusion_proof_missing` or the
 * verifier's reason -- never passes.
 *
 * `checkpoint` and `logPublicKeyPem` are the trust anchor the proof is checked
 * against (#4220). Without a verifiable signed checkpoint the entry is refused;
 * `fetchCheckpoint` is an optional `async ({ log }) => checkpoint | null` for a
 * caller that would rather fetch the checkpoint alongside the proof.
 */
async function verifyTransparencyEntry(
  { log, leafIndex, leafHash } = {},
  { fetchProof, checkpoint = null, logPublicKeyPem = '', fetchCheckpoint } = {},
) {
  if (!isNonEmptyString(log)) return fail('transparency_log_missing');
  if (leafIndex === undefined || leafIndex === null) return fail('transparency_leaf_missing');
  if (typeof fetchProof !== 'function') return fail('transparency_client_missing');

  let resolvedCheckpoint = checkpoint;
  if (!resolvedCheckpoint && typeof fetchCheckpoint === 'function') {
    try {
      resolvedCheckpoint = await fetchCheckpoint({ log });
    } catch (_) {
      return fail('checkpoint_fetch_failed', { log });
    }
  }
  if (!resolvedCheckpoint) return fail('checkpoint_missing', { log });

  let proof;
  try {
    proof = await fetchProof({ log, leafIndex });
  } catch (_) {
    return fail('transparency_fetch_failed', { log });
  }
  if (!proof) return fail('inclusion_proof_missing', { log });
  return verifyInclusionProof(leafHash, proof, { checkpoint: resolvedCheckpoint, log, logPublicKeyPem });
}

module.exports = Object.freeze({
  verifyInclusionProof,
  verifyTransparencyCheckpoint,
  verifyTransparencyEntry,
});

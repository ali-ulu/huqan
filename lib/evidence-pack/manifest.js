// SPDX-License-Identifier: LicenseRef-HUQAN-Enterprise
'use strict';

/**
 * Evidence pack manifest (#4092, PR-A1).
 *
 * A pack is a directory of trust artifacts an operator hands to an auditor.
 * The manifest is what makes the directory independently checkable: it lists
 * every file with its SHA-256 and byte length, records what each file's
 * integrity rests on, and seals the whole list with a single hash.
 *
 * The hash covers the manifest minus `packHash` and `signature`, so an auditor
 * recomputes it from the manifest alone. Canonical JSON is not redefined here:
 * `lib/hash-chain.js` owns the one serialization the receipt bundle already
 * uses, and the pack reuses it rather than growing a second dialect.
 *
 * What a pack is not is as load-bearing as what it is. The `nonClaims` list is
 * part of the sealed payload on purpose: a pack that a reader could mistake for
 * a certification would be worse than no pack, so the limits are data the
 * verifier reports rather than prose only a careful reader finds.
 */

const { stableStringify, sha256Hex } = require('../hash-chain');

const EVIDENCE_PACK_SCHEMA_VERSION = 'huqan.evidence-pack.v1';

/**
 * What backs a file's integrity, so a reader does not assume every file is
 * equally tamper-evident. `snapshot_hash_only` is the honest label for a file
 * whose only protection is this manifest's own hash.
 */
const INTEGRITY_CLASSES = Object.freeze({
  HASH_CHAINED: 'hash_chained',
  COUNTER_SEALED: 'counter_sealed',
  ISSUER_SEALED: 'issuer_sealed',
  SNAPSHOT_HASH_ONLY: 'snapshot_hash_only',
});

const INTEGRITY_CLASS_VALUES = Object.freeze(Object.values(INTEGRITY_CLASSES));

/** The limits that travel with every pack. Sealed into the manifest. */
const PACK_NON_CLAIMS = Object.freeze([
  'a valid pack is not a SOC 2 report and does not certify SOC 2 compliance',
  'a valid pack does not state that any control is satisfied or met',
  'a valid pack does not prove that the recorded events happened',
  'a valid pack does not prove that the operator is honest',
  'a valid pack does not prove independence; only a counter-seal by a key the operator does not manage speaks to that',
]);

/**
 * The exact field set `packHash` commits to: everything except the hash itself
 * and the optional signature. Key order is irrelevant -- stableStringify sorts.
 */
function canonicalPackPayload(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new TypeError('canonicalPackPayload requires a manifest object');
  }
  const { packHash, signature, ...payload } = manifest;
  return payload;
}

function computePackHash(manifest) {
  return sha256Hex(stableStringify(canonicalPackPayload(manifest)));
}

/**
 * One `files` entry. Content may be a Buffer or a string; a Buffer is hashed
 * byte for byte, a string is hashed as its UTF-8 bytes, so the recorded hash
 * matches what the verifier recomputes from the file on disk.
 */
function fileEntry(relativePath, content, integrityClass) {
  if (typeof relativePath !== 'string' || relativePath === '') {
    throw new TypeError('fileEntry requires a non-empty path');
  }
  if (!INTEGRITY_CLASS_VALUES.includes(integrityClass)) {
    throw new TypeError(`fileEntry requires a known integrityClass, got ${integrityClass}`);
  }
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  return {
    path: relativePath,
    sha256: sha256Hex(bytes),
    bytes: bytes.length,
    integrityClass,
  };
}

/** Build a sealed manifest. `files` entries come from `fileEntry`. */
function buildManifest({
  period,
  generatedAt,
  workspaceId,
  producer,
  files,
  nonClaims,
  piiTypes,
} = {}) {
  if (!Array.isArray(files)) {
    throw new TypeError('buildManifest requires a files array');
  }
  const manifest = {
    schemaVersion: EVIDENCE_PACK_SCHEMA_VERSION,
    period,
    generatedAt,
    workspaceId,
    producer,
    files,
    nonClaims: nonClaims === undefined ? [...PACK_NON_CLAIMS] : nonClaims,
  };
  // Reported, never acted on: the PII classes the egress gate saw in the pack.
  if (piiTypes !== undefined) manifest.piiTypes = piiTypes;
  manifest.packHash = computePackHash(manifest);
  return manifest;
}

module.exports = {
  EVIDENCE_PACK_SCHEMA_VERSION,
  INTEGRITY_CLASSES,
  INTEGRITY_CLASS_VALUES,
  PACK_NON_CLAIMS,
  canonicalPackPayload,
  computePackHash,
  fileEntry,
  buildManifest,
};

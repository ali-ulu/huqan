'use strict';

// Ledger anchor statements (#3940, ADR-016 residual risk 7).
//
// The authority's ledger has no witness outside this machine, so an elevated
// process could roll it back to an earlier, still valid chain. An anchor puts
// the ledger head into a public append-only log (Rekor), where nobody on this
// machine can take it back.
//
// The statement names only the head's sequence number and hash, in a fixed
// byte form, so the digest of any seq can be recomputed from the ledger
// alone: an anchored digest that matches no current entry is a rolled-back
// or rewritten ledger. It is signed with a separate ECDSA P-256 key, because
// Rekor's hashedrekord accepts Ed25519 only as Ed25519ph, which Node lacks.
//
// Part of the authority bundle (lib/authority/bundle-manifest.js).

const crypto = require('node:crypto');

const ANCHOR_VERSION = 'huqan.authority.anchor.v1';
const HEX64 = /^[0-9a-f]{64}$/;

/** The exact bytes that get anchored, for one ledger head. */
function anchorStatement({ seq, hash }) {
  if (!Number.isInteger(seq) || seq < 0 || !HEX64.test(hash || '')) {
    throw new TypeError('an anchor names a ledger seq >= 0 and its 64-hex hash');
  }
  // Built by hand rather than by key order, so the bytes never depend on how an object was assembled.
  return `{"v":"${ANCHOR_VERSION}","seq":${seq},"hash":"${hash}"}`;
}

function anchorDigest(head) {
  return crypto.createHash('sha256').update(anchorStatement(head), 'utf8').digest('hex');
}

function isP256(key) {
  return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails && key.asymmetricKeyDetails.namedCurve === 'prime256v1';
}

/** Signs a head with the anchor key: an ECDSA P-256 / SHA-256 DER signature, base64. */
function signAnchor(head, anchorKey) {
  if (!isP256(anchorKey) || anchorKey.type !== 'private') throw new TypeError('the anchor key is an ECDSA P-256 private key');
  const statement = anchorStatement(head);
  return {
    seq: head.seq,
    hash: head.hash,
    statement,
    digest: crypto.createHash('sha256').update(statement, 'utf8').digest('hex'),
    signature: crypto.sign('sha256', Buffer.from(statement, 'utf8'), anchorKey).toString('base64'),
  };
}

function verifyAnchorSignature(head, signature, publicKey) {
  try {
    if (!isP256(publicKey) || typeof signature !== 'string') return false;
    return crypto.verify('sha256', Buffer.from(anchorStatement(head), 'utf8'), publicKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

module.exports = { ANCHOR_VERSION, anchorStatement, anchorDigest, signAnchor, verifyAnchorSignature, isP256 };

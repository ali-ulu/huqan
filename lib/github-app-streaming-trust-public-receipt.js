'use strict';

// #4087: publishing a C8 Streaming Trust receipt as a public trust receipt.
//
// The public receipt is a different object for a different audience: the
// exporter signs a V4 internal receipt into a versioned, third-party
// verifiable disclosure. This module is the one seam where a C8 receipt is
// handed to it, so the C8 loop itself never learns the public format and no
// second module grows its own edge into the receipt family.
//
// The rule this module exists to hold: no signer means no publication. The
// caller passes a signer only when a public receipt key is configured, and a
// delivery without one proceeds exactly as before -- the check is still
// written and the verdict is untouched. Publication is additive, never a
// precondition.
//
// It does not swallow the exporter's error. It reports it, because only the
// caller knows the delivery already has a verdict worth keeping; deciding what
// a failed publication means belongs there, not here.

const { exportPublicTrustReceipt } = require('./receipt/public-trust-receipt');

/**
 * Publish one C8 receipt as a public trust receipt.
 *
 * @param {object} input
 * @param {object} input.internalReceipt the C8 receipt, already chained
 * @param {string} input.issuedAt canonical instant for this publication
 * @param {{keyId: string, privateKey: object}|null} [input.signer] the
 *   configured Ed25519 signer; `null`/absent means no public receipt key is
 *   configured, so nothing is published
 * @returns {{publicReceipt: object|null, error: Error|null}} `{null, null}` is
 *   "not configured, skipped"; `{null, error}` is "publication failed". The
 *   caller keeps its verdict either way.
 */
function publishStreamingTrustPublicReceipt({ internalReceipt, issuedAt, signer }) {
  if (!signer) return Object.freeze({ publicReceipt: null, error: null });
  try {
    return Object.freeze({
      publicReceipt: exportPublicTrustReceipt({ internalReceipt, issuedAt, signer }),
      error: null,
    });
  } catch (error) {
    return Object.freeze({ publicReceipt: null, error });
  }
}

module.exports = { publishStreamingTrustPublicReceipt };

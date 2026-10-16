'use strict';

/**
 * The hash an ingest records of what the source said.
 *
 * `sourceRef` names a location. A location keeps resolving after the content
 * behind it changes, so a receipt citing one cannot distinguish the source it
 * read from the source a reader is looking at now. This closes that: the exact
 * text that was learned is hashed at ingest and travels on the provenance.
 *
 * What it buys, precisely:
 *
 *   Re-read the source, hash it again, compare. Different means the source
 *   moved since ingest. That is drift detection, and it is the whole of it.
 *
 * What it does not buy: the record is not made tamper-evident. The hash sits
 * inside the record it describes, so an editor who rewrites the content and
 * recomputes the hash produces a record that agrees with itself. Only a hash
 * obtained from the source, or from the issuer through a separate channel,
 * rejects that -- the same boundary drawn for receipt bundles in
 * specs/.../RECEIPT-BUNDLE.md.
 *
 * sha256 over UTF-8, matching the receipt chain so there is one hash algorithm
 * in the system rather than two.
 */

const crypto = require('node:crypto');

const CONTENT_HASH_ALGORITHM = 'sha256';

/**
 * @param {string} content the exact text handed to learn()
 * @returns {string} lowercase hex sha256, or '' when there is nothing to hash
 */
function contentHash(content) {
  if (typeof content !== 'string' || content.length === 0) return '';
  return crypto.createHash(CONTENT_HASH_ALGORITHM).update(content, 'utf8').digest('hex');
}

module.exports = { contentHash, CONTENT_HASH_ALGORITHM };

'use strict';

// Rollback detection against the ledger anchors in Rekor (#3940, ADR-016
// residual risk 7). Pure data: the ledger entries and the verified anchors
// arrive as arguments (lib/mcp/authority-ledger-provider.js fetches both).
//
// The newest anchor is enough. The ledger is a hash chain, so if the entry an
// anchor named is still there with the same hash, every entry before it is
// unchanged too. If it is not there -- the ledger was rolled back past it, or
// rewritten -- no local check can tell, and only the anchor does.
//
// Rekor's integratedTime is a clock nobody on this machine sets: an anchored
// entry dated later than the moment the log took the anchor means the
// authority's clock ran ahead, or was moved, when that entry was written.

const { anchorDigest, verifyAnchorSignature } = require('./authority/anchor-statement');

// Ledger timestamps and Rekor's clock are different machines; allow for drift.
const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

/** The ledger entry an anchor digest names, or null. */
function findAnchoredEntry(entries, digest) {
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || !Number.isInteger(entry.seq) || typeof entry.receiptHash !== 'string') continue;
    let candidate;
    try { candidate = anchorDigest({ seq: entry.seq, hash: entry.receiptHash }); } catch { continue; }
    if (candidate === digest) return entry;
  }
  return null;
}

/**
 * @param {object|undefined} anchors what the provider found: { error } or
 *   { count, unverified, truncated, newest, match, scanned, publicKey }
 * @returns {object[]} findings; empty when anchoring was not checked or agrees
 */
function compareAnchorsWithLedger(anchors) {
  if (!anchors) return [];
  if (anchors.error) return [{ code: 'ANCHOR_LOG_UNAVAILABLE', detail: String(anchors.error) }];
  const findings = [];
  if (anchors.unverified > 0) {
    findings.push({ code: 'ANCHOR_UNVERIFIED', detail: `${anchors.unverified} log entries under the anchor key did not verify` });
  }
  if (anchors.truncated) {
    findings.push({ code: 'ANCHOR_SEARCH_TRUNCATED', detail: 'more anchors exist than were read; the newest may be among the rest' });
  }
  const newest = anchors.newest;
  if (!newest) return findings;
  const where = { logIndex: newest.logIndex, integratedTime: newest.integratedTime };
  if (!anchors.match) {
    findings.push(anchors.scanned
      ? { code: 'LEDGER_ROLLED_BACK', ...where, detail: 'the newest anchored head is not in the ledger' }
      : { code: 'ANCHOR_UNCHECKED', ...where, detail: 'the ledger could not be read far enough to find the newest anchor' });
    return findings;
  }
  const { seq, receiptHash, at } = anchors.match;
  if (!verifyAnchorSignature({ seq, hash: receiptHash }, newest.signature, anchors.publicKey)) {
    findings.push({ code: 'ANCHOR_SIGNATURE_INVALID', seq, ...where });
  }
  if (Date.parse(at) > newest.integratedTime * 1000 + CLOCK_TOLERANCE_MS) {
    findings.push({ code: 'LEDGER_CLOCK_SKEW', seq, at, ...where });
  }
  return findings;
}

module.exports = { CLOCK_TOLERANCE_MS, compareAnchorsWithLedger, findAnchoredEntry };

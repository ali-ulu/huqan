'use strict';

// Rollback detection against the ledger anchors in Rekor (#3940, ADR-016
// residual risk 7). Pure data: the ledger entries and the verified anchors
// arrive as arguments (lib/mcp/authority-ledger-provider.js fetches both).
//
// Every anchor is checked, not only the newest. An elevated process can read
// the anchor key from the service's state and anchor a rolled-back head after
// the fact, so a newest anchor that matches proves nothing on its own. The
// honest anchors made before the rollback still name heads the rolled-back
// ledger does not hold, and an anchor made later for an earlier head than one
// before it is itself the trace of such a forgery: an append-only ledger only
// ever anchors heads that move forward.
//
// Rekor's integratedTime is a clock nobody on this machine sets: an anchored
// entry dated later than the moment the log took the anchor means the
// authority's clock ran ahead, or was moved, when that entry was written.

const { anchorDigest, verifyAnchorSignature } = require('./authority/anchor-statement');

// Ledger timestamps and Rekor's clock are different machines; allow for drift.
const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;
const LISTED = 5;

/** Maps each ledger entry's anchor digest to the entry. */
function indexByAnchorDigest(entries, into = new Map()) {
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || !Number.isInteger(entry.seq) || typeof entry.receiptHash !== 'string') continue;
    try { into.set(anchorDigest({ seq: entry.seq, hash: entry.receiptHash }), entry); } catch { /* not an anchorable entry */ }
  }
  return into;
}

function grouped(code, anchors, detail) {
  return { code, count: anchors.length, logIndexes: anchors.slice(0, LISTED).map(a => a.logIndex), detail };
}

/** Anchors made later for an earlier head than an anchor before them. */
function regressions(matched) {
  const byTime = [...matched].sort((a, b) => a.integratedTime - b.integratedTime || a.logIndex - b.logIndex);
  const found = [];
  let highest = -1;
  for (const anchor of byTime) {
    if (anchor.match.seq < highest) found.push(anchor);
    highest = Math.max(highest, anchor.match.seq);
  }
  return found;
}

/**
 * @param {object|undefined} anchors what the provider found: { error } or
 *   { anchors: [{ logIndex, integratedTime, digest, signature, match }], unverified, truncated, scanned, publicKey }
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
    findings.push({ code: 'ANCHOR_SEARCH_TRUNCATED', detail: 'more anchors exist than were read' });
  }
  const list = Array.isArray(anchors.anchors) ? anchors.anchors : [];
  const missing = list.filter(a => !a.match);
  if (missing.length) {
    findings.push(anchors.scanned
      ? grouped('LEDGER_ROLLED_BACK', missing, 'anchored heads the ledger no longer holds')
      : grouped('ANCHOR_UNCHECKED', missing, 'the ledger could not be read far enough to find these anchors'));
  }
  const matched = list.filter(a => a.match);
  const badSignature = matched.filter(a => !verifyAnchorSignature({ seq: a.match.seq, hash: a.match.receiptHash }, a.signature, anchors.publicKey));
  if (badSignature.length) findings.push(grouped('ANCHOR_SIGNATURE_INVALID', badSignature, 'the signature does not match the anchored entry'));
  const skewed = matched.filter(a => Date.parse(a.match.at) > a.integratedTime * 1000 + CLOCK_TOLERANCE_MS);
  if (skewed.length) findings.push(grouped('LEDGER_CLOCK_SKEW', skewed, 'anchored entries dated after the log took them'));
  const regressed = regressions(matched);
  if (regressed.length) findings.push(grouped('ANCHOR_ORDER_REGRESSED', regressed, 'anchored later for an earlier head than an anchor before them'));
  return findings;
}

module.exports = { CLOCK_TOLERANCE_MS, compareAnchorsWithLedger, indexByAnchorDigest };

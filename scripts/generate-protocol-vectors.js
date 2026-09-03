#!/usr/bin/env node
'use strict';

/**
 * Generate the conformance vectors for huqan-trust-protocol 0.2.
 *
 * 0.2 is the canonical protocol version and shipped without any vectors of its
 * own -- `specs/huqan-trust-protocol/0.2/RECEIPT-BUNDLE.md` cited example
 * bundles that did not exist, an absence `check-docs-drift.js` had to carry as
 * two ALLOWED entries. Only the superseded `axiom-trust-protocol/0.1` shipped
 * them, so the canonical version was being conformance-tested through its
 * predecessor's fixtures (#1820).
 *
 * GENERATED, NOT HAND-WRITTEN, and that is not a convenience. A bundle is
 * sealed by a SHA-256 over its canonical serialization and its receipts are
 * hash-chained, so a hand-edited vector is a vector with a wrong hash -- and a
 * negative fixture with a wrong hash still fails verification, for the wrong
 * reason, while looking like it works. Producing them from lib/receipt means
 * the positive vectors are exactly what the implementation emits.
 *
 * The negatives are then produced by corrupting a *single field* of a valid
 * bundle, so each one isolates one failure:
 *
 *   broken-chain          a receipt's previousReceiptHash no longer matches
 *   tampered-bundle-hash  the envelope seal no longer covers the contents
 *   tampered-receipt      one receipt's own hash no longer matches its payload
 *
 * Run `node scripts/generate-protocol-vectors.js` after any change to the
 * bundle format; test/protocol-0.2-vectors.test.js fails when the committed
 * vectors no longer match what this produces.
 */

const fs = require('node:fs');
const path = require('node:path');

const { buildCanonicalReceiptPayload, hashCanonicalReceiptPayload } = require('../lib/receipt/canonical-receipt');
const { appendReceiptToChain } = require('../lib/receipt/receipt-chain');
const { exportReceiptBundle } = require('../lib/receipt/receipt-export');

const OUT_DIR = path.resolve(__dirname, '..', 'specs', 'huqan-trust-protocol', '0.2', 'examples');

// Fixed so the vectors are byte-reproducible: a timestamp or a random id would
// make every regeneration a diff and make "did the format change?" unanswerable.
const EXPORTED_AT = '2026-01-01T00:00:00.000Z';
const WORKSPACE = 'default';

function receipt(index, overrides = {}) {
  const base = {
    receiptId: `madm_receipt_0${index}`,
    receiptKind: 'memory_admission_receipt',
    decision: 'allow',
    status: 'admitted',
    admissionId: `madm_0${index}`,
    workspaceId: WORKSPACE,
    actor: 'protocol-0.2-vector-generator',
    agentId: 'kernel',
    memoryDraftId: `draft_0${index}`,
    provenanceId: `prov_0${index}`,
    trustPolicyVersion: '1.0.0',
    approvalId: 'not_applicable',
    approvalStatus: 'not_required',
    reason: 'admitted',
    riskScore: 0,
    createdAt: `2026-01-01T00:00:0${index}.000Z`,
    metadata: { vector: true },
    ...overrides,
  };
  return buildCanonicalReceiptPayload(base, { verdict: 'allow' });
}

/** A chain of `count` receipts, each linked to the previous one's hash. */
function chain(count) {
  const out = [];
  let previousHash = null;
  for (let i = 1; i <= count; i += 1) {
    const chained = appendReceiptToChain(receipt(i), previousHash);
    out.push(chained);
    previousHash = chained.receiptHash;
  }
  return out;
}

function unicodeChain() {
  // Non-ASCII in a hashed field: the canonical serialization has to agree
  // between implementations byte for byte, and this is where they diverge if
  // one of them normalizes or escapes differently.
  const payload = receipt(1, {
    actor: 'Ünïcödé aktör — 日本語',
    reason: 'kayıt kabul edildi',
    metadata: { note: 'çift baytlı içerik: αβγ 🔐' },
  });
  return [appendReceiptToChain(payload, null)];
}

function bundle(receipts) {
  return exportReceiptBundle(receipts, { workspaceId: WORKSPACE, exportedAt: EXPORTED_AT });
}

function flipLastHexDigit(hex) {
  const last = hex.slice(-1);
  const replacement = last === '0' ? '1' : '0';
  return hex.slice(0, -1) + replacement;
}

function vectors() {
  const valid = bundle(chain(3));
  const unicodeValid = bundle(unicodeChain());

  // Each negative changes exactly one field of a valid bundle, so a verifier
  // that reports two findings for one corruption is telling you something.
  const brokenChain = JSON.parse(JSON.stringify(valid));
  brokenChain.receipts[1].previousReceiptHash = flipLastHexDigit(brokenChain.receipts[1].previousReceiptHash);

  const tamperedBundleHash = JSON.parse(JSON.stringify(valid));
  tamperedBundleHash.bundleHash = flipLastHexDigit(tamperedBundleHash.bundleHash);

  const tamperedReceipt = JSON.parse(JSON.stringify(valid));
  tamperedReceipt.receipts[2].receiptHash = flipLastHexDigit(tamperedReceipt.receipts[2].receiptHash);

  return {
    'receipt-bundle.valid.json': valid,
    'receipt-bundle.unicode.valid.json': unicodeValid,
    'receipt-bundle.broken-chain.json': brokenChain,
    'receipt-bundle.tampered-bundle-hash.json': tamperedBundleHash,
    'receipt-bundle.tampered-receipt.json': tamperedReceipt,
  };
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const produced = vectors();
  for (const [name, value] of Object.entries(produced)) {
    fs.writeFileSync(path.join(OUT_DIR, name), `${JSON.stringify(value, null, 2)}\n`);
    console.log(`  wrote ${name}`);
  }
  console.log(`\n${Object.keys(produced).length} vectors in specs/huqan-trust-protocol/0.2/examples/`);
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { vectors, OUT_DIR };

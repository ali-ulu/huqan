'use strict';
/**
 * V4-PR2.5 — Trust Receipt Primitive Hardening.
 *
 * Proves the receipt primitive can actually "prove it later": receipts are
 * hash-chained (tamper across the chain is detectable), deterministically
 * serialized (same payload always hashes identically), and exportable to a
 * bundle that can be independently re-verified without any in-memory state.
 *
 * Per the orchestrator's instruction, receipts here carry the canonical
 * verdict field from V4-PR2 (lib/verdict/action-verdict.js) — not a
 * re-derived or duplicated mapping.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { evaluateMemoryAdmission } = require('../lib/memory-admission-gate');
const { fromAdmissionDecision } = require('../lib/verdict/action-verdict');
const {
  CANONICAL_RECEIPT_SCHEMA_VERSION,
  buildCanonicalReceiptPayload,
  hashCanonicalReceiptPayload,
  stableStringify,
} = require('../lib/receipt/canonical-receipt');
const {
  GENESIS_PREVIOUS_HASH,
  CHAIN_INVALID_REASONS,
  appendReceiptToChain,
  validateReceiptChain,
} = require('../lib/receipt/receipt-chain');
const { exportReceiptBundle, verifyExportedBundle } = require('../lib/receipt/receipt-export');

// Build a real receipt + canonical verdict from a real admission decision.
function realCanonicalPayload(overrides = {}) {
  const base = {
    workspaceId: 'default',
    actor: 'tester',
    agentId: 'tester',
    memoryDraftId: 'draft-fixture',
    trustPolicyVersion: '1.0.0',
    reason: 'v4-pr2-5-fixture',
    provenanceId: `prov-${Math.random().toString(36).slice(2, 8)}`,
    proposedMemory: { content: 'fact', edges: [] },
  };
  const result = evaluateMemoryAdmission({ ...base, ...overrides });
  const envelope = fromAdmissionDecision(result.decision);
  return buildCanonicalReceiptPayload(result.receipt, { verdict: envelope.verdict });
}

describe('V4-PR2.5: canonical receipt payload', () => {
  it('is a fixed, versioned payload derived from a real admission receipt + PR2 canonical verdict', () => {
    const payload = realCanonicalPayload();
    assert.strictEqual(payload.schemaVersion, CANONICAL_RECEIPT_SCHEMA_VERSION);
    assert.strictEqual(payload.verdict, 'allow');
    assert.ok(payload.receiptId, 'receiptId must be carried over from the existing receipt');
    assert.ok(payload.admissionId, 'admissionId must be carried over');
  });

  it('rejects building a payload without an explicit, canonical verdict', () => {
    const result = evaluateMemoryAdmission({
      workspaceId: 'default', actor: 'tester', agentId: 'tester',
      memoryDraftId: 'd', trustPolicyVersion: '1.0.0', reason: 'r',
      provenanceId: 'p', proposedMemory: { content: 'fact', edges: [] },
    });
    assert.throws(() => buildCanonicalReceiptPayload(result.receipt, {}), TypeError);
    assert.throws(() => buildCanonicalReceiptPayload(result.receipt, { verdict: 'not-a-real-verdict' }), TypeError);
  });

  it('deterministic serialization: the same payload always hashes identically, regardless of key order', () => {
    const payload = realCanonicalPayload();
    const reordered = {};
    for (const key of Object.keys(payload).sort().reverse()) reordered[key] = payload[key];
    assert.strictEqual(stableStringify(payload), stableStringify(reordered));
    assert.strictEqual(hashCanonicalReceiptPayload(payload), hashCanonicalReceiptPayload(reordered));
    assert.strictEqual(hashCanonicalReceiptPayload(payload), hashCanonicalReceiptPayload(payload),
      'hashing the same payload twice must be identical');
  });
});

describe('V4-PR2.5: receipt chain — linking and genesis', () => {
  it('two sequential receipts: the second previousReceiptHash equals the first receiptHash', () => {
    const first = appendReceiptToChain(realCanonicalPayload({ provenanceId: 'chain-1' }));
    const second = appendReceiptToChain(realCanonicalPayload({ provenanceId: 'chain-2' }), first.receiptHash);
    assert.strictEqual(first.previousReceiptHash, GENESIS_PREVIOUS_HASH);
    assert.strictEqual(second.previousReceiptHash, first.receiptHash);
    assert.notStrictEqual(second.receiptHash, first.receiptHash);
  });

  it('a fresh chain of N receipts validates as fully valid', () => {
    const chain = [];
    let prevHash = undefined;
    for (let i = 0; i < 4; i++) {
      const record = appendReceiptToChain(realCanonicalPayload({ provenanceId: `chain-valid-${i}` }), prevHash);
      chain.push(record);
      prevHash = record.receiptHash;
    }
    const result = validateReceiptChain(chain);
    assert.deepStrictEqual(result, { valid: true, brokenAt: null, reason: null });
  });
});

describe('V4-PR2.5: tamper detection', () => {
  it('mutating a middle receipt content invalidates the chain at that index', () => {
    const chain = [];
    let prevHash = undefined;
    for (let i = 0; i < 3; i++) {
      const record = appendReceiptToChain(realCanonicalPayload({ provenanceId: `tamper-${i}` }), prevHash);
      chain.push(record);
      prevHash = record.receiptHash;
    }
    // Tamper with the middle receipt's content without recomputing its hash.
    const tampered = chain.slice();
    tampered[1] = { ...tampered[1], reason: 'ATTACKER REWROTE THIS REASON' };

    const result = validateReceiptChain(tampered);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.brokenAt, 1);
    assert.strictEqual(result.reason, CHAIN_INVALID_REASONS.CONTENT_TAMPERED);
  });

  it('tampering AND recomputing the hash locally still breaks the link to the next receipt', () => {
    const chain = [];
    let prevHash = undefined;
    for (let i = 0; i < 3; i++) {
      const record = appendReceiptToChain(realCanonicalPayload({ provenanceId: `tamper-recompute-${i}` }), prevHash);
      chain.push(record);
      prevHash = record.receiptHash;
    }
    // Attacker mutates receipt[1] AND recomputes its own hash so it looks
    // self-consistent -- but does not (and, in a real deployment, cannot)
    // rewrite receipt[2]'s already-committed previousReceiptHash.
    const { receiptHash, ...withoutHash } = chain[1];
    const rehashed = appendReceiptToChain(
      { ...withoutHash, reason: 'ATTACKER REWROTE AND REHASHED' },
      withoutHash.previousReceiptHash
    );
    const tampered = [chain[0], rehashed, chain[2]];

    const result = validateReceiptChain(tampered);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.brokenAt, 2, 'the break must surface at the next receipt, whose previousReceiptHash no longer matches');
    assert.strictEqual(result.reason, CHAIN_INVALID_REASONS.CHAIN_LINK_BROKEN);
  });

  it('a wrong genesis marker on the first receipt is detected', () => {
    const first = appendReceiptToChain(realCanonicalPayload({ provenanceId: 'genesis-check' }));
    const forgedGenesis = { ...first, previousReceiptHash: 'not-the-real-genesis-marker' };
    const result = validateReceiptChain([forgedGenesis]);
    assert.strictEqual(result.valid, false);
    // Forging previousReceiptHash without recomputing receiptHash is itself
    // a content mismatch (receiptHash was computed over the real genesis
    // marker), so this is caught as CONTENT_TAMPERED before genesis check.
    assert.strictEqual(result.reason, CHAIN_INVALID_REASONS.CONTENT_TAMPERED);
  });
});

describe('V4-PR2.5: export / import integrity', () => {
  it('an exported bundle can be independently re-verified from the exported data alone', () => {
    const chain = [];
    let prevHash = undefined;
    for (let i = 0; i < 3; i++) {
      const record = appendReceiptToChain(realCanonicalPayload({ provenanceId: `export-${i}` }), prevHash);
      chain.push(record);
      prevHash = record.receiptHash;
    }
    const bundle = exportReceiptBundle(chain, { workspaceId: 'default' });
    // Simulate "no in-memory state": re-parse the bundle as if freshly loaded
    // from disk/network, then verify using ONLY the bundle.
    const reloaded = JSON.parse(JSON.stringify(bundle));
    const verification = verifyExportedBundle(reloaded);
    assert.strictEqual(verification.valid, true);
    assert.strictEqual(verification.bundleHashValid, true);
    assert.strictEqual(verification.chainValidation.valid, true);
  });

  it('a tampered exported bundle fails independent re-verification', () => {
    const chain = [
      appendReceiptToChain(realCanonicalPayload({ provenanceId: 'export-tamper-0' })),
    ];
    const bundle = exportReceiptBundle(chain);
    const tamperedBundle = JSON.parse(JSON.stringify(bundle));
    tamperedBundle.receipts[0].reason = 'POST-EXPORT TAMPER';

    const verification = verifyExportedBundle(tamperedBundle);
    assert.strictEqual(verification.valid, false);
    // The bundleHash itself no longer matches the (now-different) receipts
    // array, independent of the chain-level check.
    assert.strictEqual(verification.bundleHashValid, false);
  });
});

describe('V4-PR2.5: backward compatibility with existing receipt fields', () => {
  it('buildMemoryAdmissionReceipt output is unchanged and still consumable as-is', () => {
    const result = evaluateMemoryAdmission({
      workspaceId: 'default', actor: 'tester', agentId: 'tester',
      memoryDraftId: 'd', trustPolicyVersion: '1.0.0', reason: 'r',
      provenanceId: 'compat-1', proposedMemory: { content: 'fact', edges: [] },
    });
    // These are the exact fields the existing receipt consumers rely on
    // (lib/memory-admission-gate.js) -- none of them were touched by PR2.5.
    assert.ok(result.receipt.receiptId);
    assert.ok(result.receipt.receiptKind);
    assert.strictEqual(result.receipt.decision, 'allow');
    assert.strictEqual(result.receipt.status, 'admitted');
    assert.strictEqual(typeof result.receipt.canonical, 'boolean');
  });
});

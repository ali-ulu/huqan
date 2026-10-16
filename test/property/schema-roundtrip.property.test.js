'use strict';

/**
 * T1 property: schema round-trip (#2634).
 *
 * Encode → decode preserves all fields: stableStringify/JSON round-trips
 * arbitrary JSON values exactly, canonical receipt payloads survive the
 * trip, and memory records normalize deterministically (idempotent).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const {
  stableStringify,
  buildCanonicalReceiptPayload,
} = require('../../lib/receipt/canonical-receipt');
const { normalizeMemoryRecord } = require('../../lib/memory-schema');
const { CANONICAL_VERDICTS } = require('../../lib/verdict/action-verdict');

const NUM_RUNS = 1000;

const jsonArb = fc.jsonValue({ maxDepth: 4 });

describe('property: schema round-trip', () => {
  it('stableStringify round-trip preserves every field', () => {
    fc.assert(
      fc.property(jsonArb, (value) => {
        const encoded = stableStringify(value);
        const decoded = JSON.parse(encoded);
        // JSON itself cannot preserve -0 (JSON.stringify(-0) === "0"), so the
        // reference is JSON semantics, not the in-memory value: our encoding
        // must match what plain JSON round-trips, key order aside.
        const expected = JSON.parse(JSON.stringify(value));
        assert.deepEqual(decoded, expected, 'round-trip must match JSON semantics exactly');
        assert.equal(stableStringify(decoded), encoded, 'encoding must be deterministic');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('canonical receipt payloads survive encode/decode', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{1,24}$/),
        fc.constantFrom(...CANONICAL_VERDICTS),
        (token, verdict) => {
          const payload = buildCanonicalReceiptPayload(
            {
              receiptId: `r-${token}`,
              receiptKind: 'memory-admission',
              decision: 'admit',
              status: 'admitted',
              admissionId: `adm-${token}`,
              workspaceId: `ws-${token}`,
              provenanceId: `prov-${token}`,
              trustPolicyVersion: '1.0.0',
              createdAt: '2026-09-18T00:00:00.000Z',
            },
            { verdict },
          );
          const roundTripped = JSON.parse(stableStringify(payload));
          assert.deepEqual(roundTripped, payload, 'receipt payload must survive round-trip');
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('normalizeMemoryRecord is deterministic and idempotent', () => {
    const recordArb = fc.record({
      workspaceId: fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,12}$/),
      content: fc.string({ minLength: 1, maxLength: 120 }),
      kind: fc.constantFrom('note', 'fact', 'decision'),
      sourceRef: fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/),
    });
    fc.assert(
      fc.property(recordArb, (record) => {
        const once = normalizeMemoryRecord(record);
        const twice = normalizeMemoryRecord(once);
        assert.deepEqual(twice, once, 'normalization must be idempotent');
        assert.equal(stableStringify(twice), stableStringify(once), 'normalized form must be stable');
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

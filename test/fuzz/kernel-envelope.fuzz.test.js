'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fc = require('fast-check');

const {
  fail,
  ok,
  validateResult,
} = require('../../lib/kernel-envelope');

const context = Object.freeze({
  graph: { getStats: () => ({ backend: 'fuzz' }) },
  contractVersion: 'fuzz-v1',
  paranoidMode: false,
});

const metaArb = fc.dictionary(fc.string({ maxLength: 32 }), fc.jsonValue(), { maxKeys: 8 });
const evidenceArb = fc.array(
  fc.record({
    kind: fc.string({ maxLength: 24 }),
    text: fc.string({ maxLength: 128 }),
    confidence: fc.integer({ min: -5, max: 5 }),
  }),
  { maxLength: 8 },
);

test('kernel envelope fuzz: ok/fail builders always emit self-validating envelopes', { timeout: 10000 }, () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 48 }),
      fc.jsonValue(),
      evidenceArb,
      metaArb,
      (type, data, evidence, meta) => {
        const safeType = type === 'verify' ? 'fuzz-verify' : (type || 'fuzz');
        const success = ok(context, safeType, data, evidence, meta);
        assert.strictEqual(validateResult(success), success);
        assert.equal(success.ok, true);
        assert.ok(Array.isArray(success.evidence));
      },
    ),
    { numRuns: 180 },
  );

  fc.assert(
    fc.property(
      fc.string({ maxLength: 48 }),
      fc.string({ maxLength: 48 }),
      fc.string({ maxLength: 256 }),
      metaArb,
      (type, code, message, meta) => {
        const failure = fail(context, type || 'fuzz', code, message, meta);
        assert.strictEqual(validateResult(failure), failure);
        assert.equal(failure.ok, false);
        assert.deepEqual(failure.evidence, []);
      },
    ),
    { numRuns: 180 },
  );
});

test('kernel envelope fuzz: arbitrary JSON is either rejected or satisfies the validation contract', { timeout: 10000 }, () => {
  fc.assert(
    fc.property(fc.jsonValue(), (value) => {
      try {
        const accepted = validateResult(value);
        assert.equal(typeof accepted.ok, 'boolean');
        assert.ok(Array.isArray(accepted.evidence));
        if (accepted.type === 'verify' && accepted.data) {
          assert.ok(['verified', 'contradicted', 'unknown'].includes(accepted.data.status));
          assert.equal(typeof accepted.data.confidence, 'number');
          assert.ok(accepted.data.confidence >= 0 && accepted.data.confidence <= 1);
        }
      } catch (error) {
        assert.ok(error instanceof Error);
      }
    }),
    { numRuns: 260 },
  );
});

test('kernel envelope fuzz: valid verify status/confidence combinations remain accepted', { timeout: 10000 }, () => {
  fc.assert(
    fc.property(
      fc.constantFrom('verified', 'contradicted', 'unknown'),
      fc.integer({ min: 0, max: 100 }),
      (status, score) => {
        const envelope = {
          ok: true,
          type: 'verify',
          data: { status, confidence: score / 100 },
          evidence: [],
        };
        assert.strictEqual(validateResult(envelope), envelope);
      },
    ),
    { numRuns: 120 },
  );
});

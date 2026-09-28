'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fc = require('fast-check');

const { handleIngest } = require('../../lib/ingest');

function recordingKernel() {
  const calls = [];
  return {
    calls,
    kernel: {
      async runCapability(name, payload) {
        calls.push({ name, payload });
        return { ok: true };
      },
    },
  };
}

const malformedSourceTypeArb = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer(),
  fc.array(fc.jsonValue(), { maxLength: 6 }),
  fc.dictionary(fc.string({ maxLength: 24 }), fc.jsonValue(), { maxKeys: 6 }),
);

test('ingest fuzz: malformed sourceType values fail closed without capability execution', { timeout: 10000 }, async () => {
  await fc.assert(
    fc.asyncProperty(malformedSourceTypeArb, async (sourceType) => {
      const { kernel, calls } = recordingKernel();
      const result = await handleIngest({
        kernel,
        data: { sourceType },
      });

      assert.ok(result && typeof result === 'object');
      assert.equal(result.ok, false);
      assert.match(result.error, /sourceType must be one of/);
      assert.deepEqual(calls, []);
    }),
    { numRuns: 200 },
  );
});

test('ingest fuzz: arbitrary bounded JSON input never escapes as an uncaught exception', { timeout: 10000 }, async () => {
  await fc.assert(
    fc.asyncProperty(fc.jsonValue(), async (data) => {
      const { kernel } = recordingKernel();
      const result = await handleIngest({ kernel, data });

      assert.notEqual(result, undefined);
      if (result && typeof result === 'object' && result.ok === false) {
        assert.equal(typeof result.error, 'string');
        assert.ok(result.error.length > 0);
      }
    }),
    { numRuns: 250 },
  );
});

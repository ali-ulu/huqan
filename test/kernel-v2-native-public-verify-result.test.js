'use strict';

// #2344: the V2 native fail-closed negative-claim guard reached VerifyService
// through `kernel._verifyService._verifyResult(...)`. That is a different
// module's `_private` surface: it named no contract, carried no test and had
// no stability promise, so the guard and the service could only be changed
// against each other by convention. The guard now calls the public
// `verifyResult`, and this test holds it there by handing it a service that
// exposes that name and nothing else.
//
// Red before the change (the guard reached for `_verifyResult`, which this
// service does not have):
//   TypeError: service.verifyResult is not a function
//
// The envelope itself is characterized, not re-derived: same data shape, same
// negationReason and the same `negativeClaimGuard: 'fail_closed'` marker.

const test = require('node:test');
const assert = require('node:assert/strict');

const VerifyService = require('../lib/verify');
const { resolveNegativeClaimFallback } = require('../lib/kernel-v2-native');

function stubKernel() {
  return {
    ok: (cmd, data, evidence, meta) => ({ ok: true, cmd, data, evidence, meta }),
    graph: { getNode: () => null, getEdges: () => [], getEdge: () => null },
  };
}

/**
 * VerifyService as a foreign module is allowed to see it: `verifyResult` and
 * no underscore name at all. The guard has to work through this and no more.
 */
function publicOnlyService() {
  const service = new VerifyService(stubKernel());
  return {
    verifyResult: (statement, opts, data, evidence, context) => service.verifyResult(statement, opts, data, evidence, context),
  };
}

const VERIFIED_BASE = Object.freeze({
  ok: true,
  cmd: 'verify',
  data: { status: 'verified', confidence: 0.95 },
  evidence: [],
});

const NEGATED_PARSE = Object.freeze({ subject: 'kedi', predicate: 'hayvan', isNegated: true });

test('fail-closed negative-claim guard runs on the public verifyResult surface', () => {
  const kernel = { _verifyService: publicOnlyService() };

  const guarded = resolveNegativeClaimFallback(
    kernel, VERIFIED_BASE, 'kedi bir hayvan değildir', {}, 'default', NEGATED_PARSE, 'hayvan',
  );

  assert.strictEqual(guarded.data.status, 'unknown');
  assert.strictEqual(guarded.data.confidence, 0);
  assert.strictEqual(guarded.data.negationReason, 'negative_claim_has_no_known_positive_conflict');
  assert.strictEqual(guarded.meta.negativeClaimGuard, 'fail_closed');
  assert.strictEqual(guarded.meta.semanticTrust.status, 'unknown');
  assert.deepStrictEqual(guarded.evidence, []);
});

test('the guard builds no envelope for claims it does not guard', () => {
  const kernel = { _verifyService: publicOnlyService() };
  const unknownBase = { data: { status: 'unknown', confidence: 0 } };

  // Affirmative claim: not the guard's business, base passes through by identity.
  assert.strictEqual(
    resolveNegativeClaimFallback(kernel, VERIFIED_BASE, 'kedi hayvandır', {}, 'default', { isNegated: false }, 'hayvan'),
    VERIFIED_BASE,
  );
  // Negated but already not-verified: the guard only rewrites `verified`.
  assert.strictEqual(
    resolveNegativeClaimFallback(kernel, unknownBase, 'kedi bir hayvan değildir', {}, 'default', NEGATED_PARSE, 'hayvan'),
    unknownBase,
  );
});

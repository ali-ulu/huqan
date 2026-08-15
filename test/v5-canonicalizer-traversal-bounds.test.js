'use strict';

/**
 * json-stable-v1 bounds its own work, not just its output (#765).
 *
 * The profile advertises a 1 MiB message maximum, and that was the only bound
 * -- checked after the value had been fully, recursively serialized. A value
 * that is trivially small in bytes but thousands of levels deep exhausted the
 * call stack long before the byte check was reached, so a signed-content
 * primitive on the V5 verification path answered untrusted input with
 * `RangeError: Maximum call stack size exceeded`.
 *
 * Depth, node count and bytes are now budgeted during traversal. The refusals
 * are deterministic and carry a code, so a verifier can treat them as
 * malformed input rather than letting them escape as a process-level fault.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CRYPTOGRAPHIC_PROFILE_V1,
  encodeJsonStableV1,
} = require('../lib/v5/cryptographic-profile-contract');

const { maxDepth, maxNodes, maxBytes } = CRYPTOGRAPHIC_PROFILE_V1.canonicalizationLimits;

/** An object nested `levels` deep: tiny in bytes, unbounded in stack usage. */
function nestObjects(levels) {
  const root = {};
  let cursor = root;
  for (let i = 0; i < levels; i += 1) {
    cursor.a = {};
    cursor = cursor.a;
  }
  return root;
}

function nestArrays(levels) {
  let node = [];
  for (let i = 0; i < levels; i += 1) {
    node = [node];
  }
  return node;
}

test('the profile publishes the traversal limits it enforces', () => {
  assert.equal(typeof maxDepth, 'number');
  assert.equal(typeof maxNodes, 'number');
  assert.equal(maxBytes, CRYPTOGRAPHIC_PROFILE_V1.messageBytes.maximum);
  assert.ok(maxDepth > 0 && maxNodes > 0);
  assert.throws(() => {
    CRYPTOGRAPHIC_PROFILE_V1.canonicalizationLimits.maxDepth = 1;
  }, TypeError);
});

test('a deeply nested object is refused deterministically, not by the stack', () => {
  const deep = nestObjects(10000);
  // Canonicalizes to {"a":{"a":...{}...}} -- six bytes per level plus the
  // innermost {}, so ~60 KB, comfortably under the 1 MiB maximum. The old
  // failure was purely recursion, and it is not measured with JSON.stringify
  // here because that overflows on this value too.
  assert.ok((10000 * 6) + 2 < maxBytes);

  let caught = null;
  try {
    encodeJsonStableV1(deep);
  } catch (error) {
    caught = error;
  }

  assert.ok(caught, 'a 10000-deep value was canonicalized');
  assert.notEqual(caught.message, 'Maximum call stack size exceeded');
  assert.equal(caught.code, 'JSON_STABLE_V1_LIMIT');
  assert.match(caught.message, /nesting depth/);
});

test('a deeply nested array is refused the same way', () => {
  let caught = null;
  try {
    encodeJsonStableV1(nestArrays(10000));
  } catch (error) {
    caught = error;
  }
  assert.equal(caught && caught.code, 'JSON_STABLE_V1_LIMIT');
  assert.match(caught.message, /nesting depth/);
});

test('the refusal is the same every time, for the same input', () => {
  const deep = nestObjects(maxDepth + 50);
  const messages = [];
  for (let i = 0; i < 3; i += 1) {
    try {
      encodeJsonStableV1(deep);
    } catch (error) {
      messages.push(`${error.code}:${error.message}`);
    }
  }
  assert.equal(messages.length, 3);
  assert.equal(new Set(messages).size, 1);
});

test('nesting up to the limit still canonicalizes', () => {
  // maxDepth levels of nesting is allowed; the level past it is not. The root
  // value sits at depth 0, so `maxDepth` wrappers reach exactly the limit.
  const allowed = nestArrays(maxDepth);
  assert.equal(encodeJsonStableV1(allowed).toString('utf8'), '['.repeat(maxDepth) + '[]' + ']'.repeat(maxDepth));

  assert.throws(() => encodeJsonStableV1(nestArrays(maxDepth + 1)), (error) => error.code === 'JSON_STABLE_V1_LIMIT');
});

test('a value with too many nodes is refused before it is built', () => {
  // Flat, so depth is never the reason: this is the node budget alone.
  const wide = [];
  for (let i = 0; i < maxNodes + 10; i += 1) wide.push(0);

  assert.throws(
    () => encodeJsonStableV1(wide),
    (error) => error.code === 'JSON_STABLE_V1_LIMIT' && /maximum nodes/.test(error.message)
  );
});

test('the byte budget is enforced during traversal, not after', () => {
  const big = { blob: 'x'.repeat(maxBytes + 1) };
  assert.throws(
    () => encodeJsonStableV1(big),
    (error) => error.code === 'JSON_STABLE_V1_LIMIT' && /maximum bytes/.test(error.message)
  );
});

test('ordinary values are unaffected by the budgets', () => {
  assert.equal(
    encodeJsonStableV1({ outer: { z: true, a: [3, { b: 2, a: 1 }] } }).toString('utf8'),
    '{"outer":{"a":[3,{"a":1,"b":2}],"z":true}}'
  );
  assert.equal(encodeJsonStableV1([]).toString('utf8'), '[]');
  assert.equal(encodeJsonStableV1({}).toString('utf8'), '{}');
});

test('rejection semantics for unsupported shapes are unchanged', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => encodeJsonStableV1(cyclic), TypeError);

  const accessor = {};
  Object.defineProperty(accessor, 'a', { get: () => 1, enumerable: true, configurable: true });
  assert.throws(() => encodeJsonStableV1(accessor), TypeError);

  assert.throws(() => encodeJsonStableV1(Object.create({ inherited: 1 })), TypeError);
  assert.throws(() => encodeJsonStableV1(new Date()), TypeError);
  assert.throws(() => encodeJsonStableV1(undefined), TypeError);
  assert.throws(() => encodeJsonStableV1(Number.NaN), TypeError);
});

test('a budget refusal survives one traversal without poisoning the next', () => {
  // The budget is per call, so a refused value must not leave a later,
  // perfectly ordinary value counted against a spent allowance.
  assert.throws(() => encodeJsonStableV1(nestObjects(maxDepth + 1)));
  assert.equal(encodeJsonStableV1({ ok: true }).toString('utf8'), '{"ok":true}');
});

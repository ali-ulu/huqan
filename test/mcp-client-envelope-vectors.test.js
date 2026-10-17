'use strict';

/**
 * Conformance vectors for the MCP client envelope (#3997).
 *
 * The specification is docs/mcp-client-envelope-spec.md; the reference verifier
 * and the vector generator are scripts/generate-mcp-client-envelope-vectors.js.
 * This test is the bridge: it asserts the committed vectors are exactly what
 * the generator produces, that the positive vector verifies, and that each
 * negative vector fails at exactly one step -- and that every verification code
 * the specification defines has a vector, so a code added to the spec without
 * one fails here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { vectors, verifyEnvelope, CODES, OUT_DIR, argsSha256 } = require('../scripts/generate-mcp-client-envelope-vectors');

const read = (name) => JSON.parse(fs.readFileSync(path.join(OUT_DIR, name), 'utf8'));

test('the committed vectors are exactly what the generator produces', () => {
  // The envelope's args_sha256 and its signature are both computed over a
  // canonical serialization, so a hand-edited vector is a vector whose bytes no
  // longer describe the format. Regenerating and comparing is the only way to
  // know the fixtures still describe the format.
  const produced = vectors();
  const committed = fs.readdirSync(OUT_DIR).filter((name) => name.endsWith('.json')).sort();
  assert.deepEqual(committed, Object.keys(produced).sort(), 'committed vector set differs from the generator');
  for (const [name, expected] of Object.entries(produced)) {
    assert.deepEqual(read(name), expected, `${name} is stale; run node scripts/generate-mcp-client-envelope-vectors.js and commit`);
  }
});

test('the vectors carry no private key', () => {
  for (const name of fs.readdirSync(OUT_DIR)) {
    const text = fs.readFileSync(path.join(OUT_DIR, name), 'utf8');
    assert.doesNotMatch(text, /PRIVATE KEY|"private_key"|"seed"/, `${name} must carry public material only`);
  }
});

test('the positive vector verifies', () => {
  const v = read('valid.json');
  assert.deepEqual(verifyEnvelope(v.envelope, v.call, v.enrolled), {
    ok: true,
    payload: { client_id: v.envelope.client_id, workspace_id: v.envelope.workspace_id, op: v.envelope.op },
  });
});

test('each negative vector fails with the code it declares', () => {
  const negatives = Object.values(vectors()).filter((v) => v.expect.ok === false);
  assert.ok(negatives.length > 0);
  for (const v of negatives) {
    assert.deepEqual(verifyEnvelope(v.envelope, v.call, v.enrolled), { ok: false, code: v.expect.code }, v.name);
  }
});

test('every verification code the specification defines has a vector', () => {
  const covered = new Set(Object.values(vectors()).filter((v) => v.expect.ok === false).map((v) => v.expect.code));
  for (const code of CODES) {
    assert.ok(covered.has(code), `no vector covers the ${code} step; add one to the generator`);
  }
});

test('each negative vector differs from the valid one at a single step', () => {
  // A negative vector that is broken in two places still fails, for the wrong
  // reason, and would hide a verifier that skips a step. Re-verifying each
  // negative against the *valid* call/enrolled (except where the vector is the
  // call that changed) shows the failure comes from the corrupted envelope, not
  // from an unrelated difference.
  const valid = read('valid.json');
  for (const v of Object.values(vectors())) {
    if (v.expect.ok !== false) continue;
    if (v.name === 'not-yet-valid' || v.name === 'expired' || v.name === 'replayed'
      || v.name === 'binding-mismatch' || v.name === 'args-mismatch') {
      // These corrupt the call, not the envelope: the envelope must still be the
      // valid one, so the failure is attributable to the changed call alone.
      assert.deepEqual(v.envelope, valid.envelope, `${v.name} must reuse the valid envelope`);
      continue;
    }
    assert.deepEqual(v.call, valid.call, `${v.name} must reuse the valid call`);
    assert.deepEqual(v.enrolled, valid.enrolled, `${v.name} must reuse the enrolled key`);
  }
});

test('the args digest binds the canonical argument serialization', () => {
  // Key order must not change the digest: canonicalJson sorts keys, so the same
  // logical arguments hash the same regardless of insertion order.
  const a = argsSha256({ b: 2, a: 1 });
  const b = argsSha256({ a: 1, b: 2 });
  assert.equal(a, b);
});

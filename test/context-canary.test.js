'use strict';

// AB14 context canary: the id verifies itself, so every rewrite an agent is
// likely to apply on the way out (prefix dropped, case changed, zero-width
// split, base64 / hex / percent encoded, uuid-shaped) must still trip, and
// ordinary hex that is not a canary must not.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CONTEXT_CANARY_REASONS,
  canaryFingerprint,
  evaluateContextCanaries,
  isContextCanaryId,
  issueContextCanary,
  plantContextCanaryInValue,
} = require('../lib/context-canary');

const FIXED = issueContextCanary({ randomBytes: () => Buffer.from('00112233445566778899aabb', 'hex') });

function uuidShape(id) {
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

test('an issued canary verifies and its marker names it', () => {
  const canary = issueContextCanary();
  assert.ok(isContextCanaryId(canary.canaryId));
  assert.equal(canary.marker, `[[HUQAN-CANARY:${canary.canaryId}]]`);
  assert.equal(canary.fingerprint, canaryFingerprint(canary.canaryId));
  assert.notEqual(canary.fingerprint, canary.canaryId);
});

test('a single flipped character is not a canary', () => {
  const last = FIXED.canaryId.at(-1) === '0' ? '1' : '0';
  assert.equal(isContextCanaryId(FIXED.canaryId.slice(0, -1) + last), false);
});

const REWRITES = [
  ['the marker as planted', `system prompt says ${FIXED.marker} ok`, 'plain'],
  ['prefix dropped, bare id', `id=${FIXED.canaryId}`, 'plain'],
  ['upper-cased', FIXED.marker.toUpperCase(), 'plain'],
  ['uuid-shaped', `ref ${uuidShape(FIXED.canaryId)}`, 'plain'],
  ['zero-width split', FIXED.canaryId.split('').join('\u200b'), 'normalized'],
  ['fullwidth digits', FIXED.marker.replace(/[0-9]/g, (d) => String.fromCharCode(0xff10 + Number(d))), 'normalized'],
  ['base64', Buffer.from(`leak: ${FIXED.marker}`).toString('base64'), 'base64'],
  ['base64url', Buffer.from(`leak: ${FIXED.marker}`).toString('base64url'), 'base64'],
  ['hex-encoded text', Buffer.from(`leak: ${FIXED.marker}`).toString('hex'), 'hex'],
  ['percent-encoded query', `https://x.example/?q=${[...FIXED.marker].map((c) => `%${c.charCodeAt(0).toString(16)}`).join('')}`, 'percent'],
];

for (const [name, text, encoding] of REWRITES) {
  test(`trips on ${name}`, () => {
    const result = evaluateContextCanaries({ command: text });
    assert.equal(result.decision, 'block');
    assert.equal(result.reason, CONTEXT_CANARY_REASONS.TRIPPED);
    assert.deepEqual(result.canaryFingerprints, [FIXED.fingerprint]);
    assert.ok(result.encodings.includes(encoding), `expected ${encoding} in ${result.encodings}`);
  });
}

test('finds a canary in a nested value and in an object key', () => {
  assert.equal(evaluateContextCanaries({ a: [{ b: ['x', FIXED.marker] }] }).decision, 'block');
  assert.equal(evaluateContextCanaries({ [FIXED.canaryId]: 1 }).decision, 'block');
});

test('ordinary hex is not a canary: md5, sha1, sha256, uuid, base64 blobs', () => {
  const crypto = require('node:crypto');
  const payload = {
    md5: crypto.createHash('md5').update('a').digest('hex'),
    sha1: crypto.createHash('sha1').update('a').digest('hex'),
    sha256: crypto.createHash('sha256').update('a').digest('hex'),
    uuid: crypto.randomUUID(),
    blob: crypto.randomBytes(256).toString('base64'),
    path: 'src/components/mirage/attacker-table.tsx and lib/external-action-egress-gates.js',
  };
  const result = evaluateContextCanaries(payload);
  assert.equal(result.decision, 'allow');
  assert.equal(result.reason, CONTEXT_CANARY_REASONS.CLEAN);
  assert.deepEqual(result.canaryFingerprints, []);
});

test('the result never carries the canary id or marker', () => {
  const serialized = JSON.stringify(evaluateContextCanaries({ text: FIXED.marker }));
  assert.equal(serialized.includes(FIXED.canaryId), false);
});

test('two canaries are reported once each, sorted', () => {
  const other = issueContextCanary({ randomBytes: () => Buffer.from('ffeeddccbbaa998877665544', 'hex') });
  const result = evaluateContextCanaries([FIXED.marker, other.marker, FIXED.canaryId]);
  assert.deepEqual(result.canaryFingerprints, [FIXED.fingerprint, other.fingerprint].sort());
});

test('a cyclic payload terminates', () => {
  const cyclic = { text: 'clean' };
  cyclic.self = cyclic;
  assert.equal(evaluateContextCanaries(cyclic).decision, 'allow');
});

test('a planted canary survives an own __proto__ key on the payload', () => {
  const payload = JSON.parse(`{"__proto__":"secret","note":"hi"}`);
  const planted = plantContextCanaryInValue(payload);
  assert.equal(Object.prototype.hasOwnProperty.call(planted.payload, '__proto__'), true);
  assert.equal(evaluateContextCanaries(planted.payload).decision, 'block');
});

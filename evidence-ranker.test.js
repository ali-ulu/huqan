const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WEIGHTS,
  rankEvidence,
  adjustedConfidence,
} = require('./evidence-ranker');

test('WEIGHTS: required evidence types exist', () => {
  assert.deepEqual(Object.keys(WEIGHTS).sort(), [
    'benchmark',
    'blog',
    'chat_memory',
    'docs',
    'experiment',
    'peer_reviewed',
    'replicated',
    'user_experience',
    'user_opinion',
  ]);
});

test('rankEvidence: returns mapped weights', () => {
  assert.equal(rankEvidence('user_opinion'), 0.25);
  assert.equal(rankEvidence('user_experience'), 0.4);
  assert.equal(rankEvidence('chat_memory'), 0.45);
  assert.equal(rankEvidence('blog'), 0.5);
  assert.equal(rankEvidence('docs'), 0.6);
  assert.equal(rankEvidence('benchmark'), 0.7);
  assert.equal(rankEvidence('experiment'), 0.8);
  assert.equal(rankEvidence('peer_reviewed'), 0.9);
  assert.equal(rankEvidence('replicated'), 1.0);
});

test('rankEvidence: unknown type falls back to 0.25', () => {
  assert.equal(rankEvidence('unknown_type'), 0.25);
  assert.equal(rankEvidence(undefined), 0.25);
});

test('adjustedConfidence: multiplies base by type weight', () => {
  assert.equal(adjustedConfidence(0.8, 'docs'), 0.48);
  assert.equal(adjustedConfidence(1, 'replicated'), 1);
});

test('adjustedConfidence: clamps output to [0,1]', () => {
  assert.equal(adjustedConfidence(2, 'replicated'), 1);
  assert.equal(adjustedConfidence(-1, 'replicated'), 0);
});

test('adjustedConfidence: non-numeric base is treated as 0', () => {
  assert.equal(adjustedConfidence('abc', 'docs'), 0);
  assert.equal(adjustedConfidence(null, 'docs'), 0);
});

const PROTOTYPE_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', '__proto__'];

test('rankEvidence: prototype key names fall through to the default (#1033)', () => {
  // A plain object literal inherits from Object.prototype, so WEIGHTS[type]
  // returned a function rather than undefined and `??` never applied 0.25.
  for (const key of PROTOTYPE_KEYS) {
    const weight = rankEvidence(key);
    assert.equal(typeof weight, 'number', key);
    assert.equal(weight, 0.25, key);
  }
});

test('adjustedConfidence: never returns NaN (#1033)', () => {
  // `NaN < 0` and `NaN > 1` are both false, so NaN passed straight through the
  // clamp and reached callers as a serialized `null` -- indistinguishable from
  // "no confidence".
  for (const key of PROTOTYPE_KEYS) {
    const value = adjustedConfidence(0.9, key);
    assert.ok(Number.isFinite(value), `${key} produced ${value}`);
    assert.equal(value, 0.225, key);
  }
  assert.ok(Number.isFinite(adjustedConfidence(0.9, undefined)));
  assert.ok(Number.isFinite(adjustedConfidence(0.9, null)));
});

test('WEIGHTS: has no prototype chain to inherit from (#1033)', () => {
  assert.equal(Object.getPrototypeOf(WEIGHTS), null);
  // It still serializes and enumerates as before -- workflow-tools puts it
  // straight into its JSON output.
  assert.equal(JSON.parse(JSON.stringify(WEIGHTS)).docs, 0.6);
});

test('rankEvidence workflow tool ranks a prototype-named type last, not first (#1033)', () => {
  const { createWorkflowTools } = require('./workflow-tools');
  const tools = createWorkflowTools({});
  const tool = Object.values(tools).find(item => item && item.name === 'rankEvidence');
  const out = tool.run({}, { evidence: [
    { type: 'constructor', confidence: 0.9 },
    { type: 'docs', confidence: 0.8 },
  ] });

  const ranked = JSON.parse(JSON.stringify(out.data.evidence));
  // The NaN entry used to sort to the head -- presented as the most
  // trustworthy evidence -- and lost its `weight` field entirely in JSON,
  // because a function does not serialize.
  assert.deepEqual(ranked.map(item => item.type), ['docs', 'constructor']);
  for (const item of ranked) {
    assert.equal(typeof item.weight, 'number', `${item.type} must keep its weight`);
    assert.ok(Number.isFinite(item.adjustedConfidence), `${item.type} adjustedConfidence`);
  }
});

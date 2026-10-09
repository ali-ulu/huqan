'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encodeTextPair, STEPS, FEATURE_SPEC_DIGEST } = require('../lib/semantic-model-text-features');
const pair = { stored: { text: 'Kapı açıktır.' }, incoming: { text: 'Kapı kapalıdır.' } };
const { v2 } = require('../lib/semantic-model-text-features');
const { sha256Hex, stableStringify } = require('../lib/hash-chain');
const record = (premise, hypothesis) => ({ stored: { text: premise }, incoming: { text: hypothesis } });

// Query a named coordinate using the published FNV1a/UTF16 contract.
function value(vector, name) {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) hash = Math.imul(hash ^ name.charCodeAt(i), 16777619) >>> 0;
  const offset = vector.indices.indexOf(hash % v2.FEATURE_SPEC.dimensions);
  return offset < 0 ? 0 : vector.values[offset];
}

test('text features retain direction, ignore supervision and have fixed Float32 shape', () => {
  const vector = encodeTextPair(pair);
  assert.ok(vector instanceof Float32Array);
  assert.equal(vector.length, STEPS);
  assert.ok(Array.from(vector).every(Number.isFinite));
  assert.deepEqual(vector, encodeTextPair({ ...pair, label: 'NEUTRAL', split: 'holdout', reviewerId: 'hidden' }));
  assert.notDeepEqual(vector, encodeTextPair({ stored: pair.incoming, incoming: pair.stored }));
  assert.match(FEATURE_SPEC_DIGEST, /^sha256:[a-f0-9]{64}$/);
});

test('v2 keeps v1 artifacts valid and refuses mixing sparse features with v1 weights', () => {
  const { validateArtifact } = require('../lib/semantic-model-artifact');
  const { loadSemanticModel } = require('../lib/semantic-model-inference');
  assert.equal(FEATURE_SPEC_DIGEST, 'sha256:2f0fb8595b4d1160a016722fdb21b82f6d22bff168735762f74a61ce493bdf20');
  assert.notEqual(v2.FEATURE_SPEC_DIGEST, FEATURE_SPEC_DIGEST);
  for (const family of ['ssm', 'rwkv', 'mamba', 'transformer']) {
    const artifact = require(`../lib/semantic-model-artifacts/${family}.json`);
    validateArtifact(artifact);
    assert.equal(loadSemanticModel(artifact).predict(pair).authority, 'CANDIDATE_ONLY');
    assert.throws(() => validateArtifact({ ...artifact, featureSpecDigest: v2.FEATURE_SPEC_DIGEST }), /spec_unknown/);
  }
});

test('v2 tokenizes EN contractions, TR dotted/dotless I and canonical Unicode', () => {
  assert.deepEqual(v2.tokenize('I don’t sleep, EVER!', 'en'), ['i', "don't", 'sleep', 'ever']);
  assert.deepEqual(v2.tokenize('IŞIK İÇİN Ankara’da', 'tr'), ['ışık', 'için', "ankara'da"]);
  const text = 'İçeride café açık.';
  assert.deepEqual(v2.tokenize(text, 'tr'), v2.tokenize(text.normalize('NFD'), 'tr'));
  for (const language of [undefined, 'auto', 'de', 'TR']) {
    assert.throws(() => v2.tokenize('text', language), /semantic_language_invalid/);
  }
  for (const text of ['', ' ', null, '!!!', 'a'.repeat(2049)]) {
    assert.throws(() => v2.encodeTextPair(record(text, 'valid'), { language: 'en' }), /semantic_text_invalid/);
    assert.throws(() => v2.encodeTextPair(record('valid', text), { language: 'en' }), /semantic_text_invalid/);
  }
});

test('v2 compares sentences at word level and preserves hypothesis order', () => {
  const vector = v2.encodeTextPair(record('A dog runs', 'A cat runs'), { language: 'en' });
  assert.equal(value(vector, 'en:novel-surface:cat'), 1);
  assert.equal(value(vector, 'en:novel-surface:runs'), 0);
  assert.equal(value(vector, 'en:surface-overlap:6'), 1);
  assert.equal(value(vector, 'en:hypothesis-unigram:cat'), 1);
  assert.equal(value(vector, 'en:hypothesis-bigram:cat runs'), 1);
  const reversed = v2.encodeTextPair(record('A cat runs', 'A dog runs'), { language: 'en' });
  assert.equal(value(reversed, 'en:novel-surface:dog'), 1);
  assert.notDeepEqual(vector, reversed);
  assert.notDeepEqual(vector, v2.encodeTextPair(record('A dog runs', 'runs cat A'), { language: 'en' }));
  assert.equal(value(v2.encodeTextPair(record('cat', 'cat cat'), { language: 'en' }), 'en:hypothesis-unigram:cat'), 1);
});

test('v2 TR overlap recognizes guarded inflection while retaining raw lexical features', () => {
  const vector = v2.encodeTextPair(record('Kitaplar masadadır', 'Kitap masada'), { language: 'tr' });
  assert.equal(value(vector, 'tr:surface-overlap:0'), 1);
  assert.equal(value(vector, 'tr:stem-overlap:10'), 1);
  assert.equal(value(vector, 'tr:novel-surface:kitap'), 1);
  assert.equal(value(vector, 'tr:novel-stem:kitap'), 0);
  const proper = v2.encodeTextPair(record('Ankara', "Ankara'da"), { language: 'tr' });
  assert.equal(value(proper, 'tr:stem-overlap:10'), 1);
  const protectedWord = v2.encodeTextPair(record('kül', 'kültür'), { language: 'tr' });
  assert.equal(value(protectedWord, 'tr:stem-overlap:0'), 1);
});

test('v2 EN/TR negation handles words and finite suffixes without treating bare ma/me as negation', () => {
  for (const text of ['not open', "isn't open", 'nobody works', 'never open']) {
    const vector = v2.encodeTextPair(record('open', text), { language: 'en' });
    assert.equal(value(vector, 'en:negation-mismatch:1'), 1, text);
  }
  for (const text of ['değil', 'değildir', 'yok', 'çalışmadı', 'gelmedi', 'çalışmıyor', 'gelmiyor', 'gelmez']) {
    const vector = v2.encodeTextPair(record('açık', text), { language: 'tr' });
    assert.equal(value(vector, 'tr:negation-mismatch:1'), 1, text);
  }
  for (const text of ['elma', 'kalem', 'malzeme', 'çalışıyor']) {
    const vector = v2.encodeTextPair(record('açık', text), { language: 'tr' });
    assert.equal(value(vector, 'tr:hypothesis-negation:0'), 1, text);
  }
  const both = v2.encodeTextPair(record('yok', 'değil'), { language: 'tr' });
  assert.equal(value(both, 'tr:negation-mismatch:0'), 1);
});

test('v2 ignores supervision and hypothesis-only baseline never reads premise', () => {
  const input = record('a dog runs', 'a cat runs');
  const options = { language: 'en' };
  assert.deepEqual(v2.encodeTextPair(input, options), v2.encodeTextPair({ ...input,
    label: 'CONTRADICTION', split: 'holdout', reviewerId: 'secret', teacher: 'hidden' }, options));
  const baseline = v2.encodeTextPair({ incoming: input.incoming,
    get stored() { throw new Error('premise leakage'); } }, { ...options, hypothesisOnly: true });
  assert.deepEqual(baseline, v2.encodeTextPair(record('unrelated', 'a cat runs'), { ...options, hypothesisOnly: true }));
  assert.equal(value(baseline, 'en:novel-surface:cat'), 0);
  assert.equal(value(baseline, 'en:hypothesis-unigram:cat'), 1);
  assert.throws(() => v2.encodeTextPair(input, { ...options, hypothesisOnly: 'false' }), /options_invalid/);
});

test('v2 sparse coordinates have frozen portable golden bytes and bounded finite values', () => {
  assert.equal(v2.FEATURE_SPEC_DIGEST, 'sha256:ac510cdbb5360b479e0ef72f8d1c56c253a478e1c39ea8b75cbdebc816e3e34d');
  for (const [language, premise, hypothesis, expected] of [
    ['en', 'A person is walking outside.', 'Nobody is walking outside.', '1fc8292d051a606d24c3a15d254ec7a14d72df370fdda1adbac3d84deb865706'],
    ['tr', 'Kitaplar masadadır.', 'Kitap masada değil.', '83e94d3e8d2b44eb96cf3e5306009173512c9dbde092ececc5c7a8fc9397330f'],
  ]) {
    const vector = v2.encodeTextPair(record(premise, hypothesis), { language });
    assert.equal(sha256Hex(stableStringify({ indices: Array.from(vector.indices), values: Array.from(vector.values) })), expected);
  }
  const vector = v2.encodeTextPair(record('x '.repeat(1024), 'y '.repeat(1024)), { language: 'en' });
  assert.equal(vector.dimensions, 2 ** 18);
  assert.ok(vector.indices instanceof Uint32Array);
  assert.ok(vector.values instanceof Float32Array);
  assert.ok(vector.values.every(v => Number.isFinite(v) && v > 0));
  assert.ok(vector.indices.every((v, i, indices) => v < vector.dimensions && (!i || v > indices[i - 1])));
  assert.equal(vector.indices.length, vector.values.length);
  assert.ok(Object.isFrozen(v2.FEATURE_SPEC.blocks));
});

test('Unicode normalization is stable and malformed or oversized text fails closed', () => {
  const composed = { stored: { text: 'Café açık.' }, incoming: { text: 'Café kapalı.' } };
  assert.deepEqual(encodeTextPair(composed), encodeTextPair({
    stored: { text: composed.stored.text.normalize('NFD') }, incoming: { text: composed.incoming.text.normalize('NFD') } }));
  for (const text of ['', ' ', null, 'a'.repeat(2049)]) {
    assert.throws(() => encodeTextPair({ stored: { text }, incoming: pair.incoming }), /semantic_text_invalid/);
  }
});

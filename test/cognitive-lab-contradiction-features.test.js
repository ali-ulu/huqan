'use strict';

// R50 PR3 (issue #3582): the frozen feature contract. These tests lock the
// properties that keep arm C label-blind and bounded:
//
//   - the vector is exactly the preregistered width and order, digest-pinned;
//   - split, label, pairId, reviewer and source path edits do not move a
//     feature, so a label edit cannot leak into training;
//   - no raw text, token, embedding or external score is read;
//   - a malformed record is refused, not silently featurized.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  FEATURE_ORDER, FEATURE_SPEC_DIGEST, FEATURE_SPEC_VERSION, FIRED_RULES,
  FEATURES_ERROR_CODES, ContradictionFeaturesError, extractFeatures,
} = require('../lib/cognitive-lab-contradiction-features.js');
const { stableStringify, sha256Hex } = require('../lib/hash-chain');

const CORPUS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/contradiction-eval-v1.corpus.json'), 'utf8'));
const LABELS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/contradiction-eval-v1.labels.json'), 'utf8'));

test('the feature vector is the pinned width and every entry is finite', () => {
  const { vector, named } = extractFeatures(CORPUS.records[0]);
  assert.equal(vector.length, FEATURE_ORDER.length);
  assert.equal(vector.length, FIRED_RULES.length + 9);
  for (const value of vector) assert.ok(Number.isFinite(value));
  assert.equal(typeof named.sameSubject, 'number');
});

test('the frozen feature order matches the preregistration', () => {
  assert.deepEqual([...FEATURE_ORDER], [
    ...FIRED_RULES.map((rule) => `fired.${rule}`),
    'contradictionSignalCount', 'maxSeverity', 'maxDeclaredConfidence', 'evidenceCount',
    'sameSubject', 'sourceTypeKnown', 'sameSourceType', 'frameKnown', 'sameFrame',
  ]);
});

test('the feature vector ignores split, label, pairId and reviewer identity', () => {
  const base = CORPUS.records.find((record) => LABELS.labels[record.pairId]);
  const plain = extractFeatures(base);
  const edited = extractFeatures({
    ...base, pairId: 'pair:rewritten', split: 'holdout',
    label: base.label === 'CONTRADICTION' ? 'NOT_CONTRADICTION' : 'CONTRADICTION',
    reviewer: 'someone-else', candidateId: 'x', path: '/tmp/x',
  });
  assert.deepEqual([...plain.vector], [...edited.vector]);
});

test('the feature spec digest pins the version and name/order list', () => {
  assert.match(FEATURE_SPEC_DIGEST, /^[a-f0-9]{64}$/);
  assert.equal(FEATURE_SPEC_DIGEST, sha256Hex(stableStringify({ version: FEATURE_SPEC_VERSION, order: FEATURE_ORDER })));
});

test('the extractor requires only deterministic repo modules, no model or embedding package', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/cognitive-lab-contradiction-features.js'), 'utf8');
  const requires = [...source.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]);
  assert.deepEqual([...requires].sort(), ['./contradiction-rules', './contradiction-rules-text', './hash-chain', './is-plain-object']);
  for (const forbidden of ['embedding', 'tfidf', 'llmAdapter', 'huggingface', 'transformers', 'onnx']) {
    assert.equal(requires.some((request) => request.toLowerCase().includes(forbidden)), false, `feature extractor must not require ${forbidden}`);
  }
});

test('a malformed record is rejected, not silently featurized', () => {
  assert.throws(() => extractFeatures(null),
    (error) => error instanceof ContradictionFeaturesError && error.code === FEATURES_ERROR_CODES.INVALID_RECORD);
});

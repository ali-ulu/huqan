'use strict';

const { stableStringify, sha256Hex } = require('./hash-chain');
const { extractFeatures, FEATURE_ORDER } = require('./cognitive-lab-contradiction-features');

const FEATURE_SPEC = Object.freeze({ version: 'huqan-semantic-text-v1', normalization: 'NFC-lowercase-NFC',
  buckets: 32, ngrams: Object.freeze([2, 3, 4]), maxTextLength: 2048,
  blocks: Object.freeze(['stored', 'incoming', 'difference', 'product']), rules: FEATURE_ORDER });
const FEATURE_SPEC_DIGEST = `sha256:${sha256Hex(stableStringify(FEATURE_SPEC))}`;
const STEPS = FEATURE_SPEC.buckets * FEATURE_SPEC.blocks.length + FEATURE_ORDER.length;

/** Bounded, directional text features; labels, reviewer IDs and split are never read. */
function textVector(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > FEATURE_SPEC.maxTextLength) {
    throw new TypeError('semantic_text_invalid');
  }
  const normalized = text.normalize('NFC').toLowerCase().normalize('NFC');
  const chars = Array.from(`^${normalized}$`);
  const vector = new Float32Array(FEATURE_SPEC.buckets);
  let total = 0;
  for (const size of FEATURE_SPEC.ngrams) {
    for (let offset = 0; offset + size <= chars.length; offset++) {
      const gram = chars.slice(offset, offset + size).join('');
      let hash = 2166136261;
      for (let i = 0; i < gram.length; i++) hash = Math.imul(hash ^ gram.charCodeAt(i), 16777619) >>> 0;
      vector[hash % vector.length] += 1;
      total++;
    }
  }
  for (let i = 0; i < vector.length; i++) vector[i] /= Math.max(1, total);
  return vector;
}

/** Reuse the frozen R50 rule feature contract alongside text-derived features. */
function encodeTextPair(record) {
  const stored = textVector(record?.stored?.text);
  const incoming = textVector(record?.incoming?.text);
  const vector = new Float32Array(STEPS);
  vector.set(stored);
  vector.set(incoming, stored.length);
  for (let i = 0; i < stored.length; i++) {
    vector[stored.length * 2 + i] = incoming[i] - stored[i];
    vector[stored.length * 3 + i] = incoming[i] * stored[i];
  }
  vector.set(extractFeatures({ stored: record.stored, incoming: record.incoming }).vector, stored.length * 4);
  return vector;
}

// Existing callers stay on v1. A learner must explicitly select the v2 contract.
module.exports = { FEATURE_SPEC, FEATURE_SPEC_DIGEST, STEPS, encodeTextPair,
  v2: require('./semantic-model-text-features-v2') };

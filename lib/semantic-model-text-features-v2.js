'use strict';

const { stableStringify, sha256Hex } = require('./hash-chain');
const { normalize: normalizeTurkish } = require('../nlp/lang-tr');
const { stripCopulaOrKeep } = require('./turkish-copula');

// A separate, opt-in sparse contract for R55's learner. Never feed these
// coordinates to a v1 reservoir/readout: its digest and dense shape are frozen.
const FEATURE_SPEC = Object.freeze({
  version: 'huqan-semantic-text-v2',
  dimensions: 2 ** 18,
  maxTextLength: 2048,
  languages: Object.freeze(['en', 'tr']),
  normalization: 'NFC-explicit-TR-I-lowercase-NFC-curly-apostrophe',
  tokenPattern: "[\\p{L}\\p{M}\\p{N}]+(?:'[\\p{L}\\p{M}\\p{N}]+)*",
  morphology: 'lang-tr-guarded-case-plural-and-turkish-copula-v1',
  englishNegation: Object.freeze(['no', 'not', 'never', 'none', 'nobody', 'nothing', 'neither', 'nor', 'without']),
  turkishNegation: Object.freeze(['değil', 'yok', 'hiç', 'asla']),
  // Only finite verb endings: bare -ma/-me is ambiguous (elma, kalem).
  turkishNegativeVerb: '^(.{2,}?)(?:m[ae](?:d[ıi](?:m|n|k|n[ıi]z|lar|ler)?|z(?:lar|ler)?)|m[ıiuü]yor(?:um|sun|uz|sunuz|lar|ler)?)$',
  lengthBounds: Object.freeze([0, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048]),
  overlapBins: 10,
  blocks: Object.freeze(['bias', 'hypothesis-unigram', 'hypothesis-bigram', 'novel-surface',
    'novel-stem', 'surface-overlap', 'stem-overlap', 'length', 'negation']),
  hash: 'FNV1a-32-UTF16-unsigned-modulo',
  values: 'binary-named-features-summed-on-collision',
  order: 'ascending-numeric-index',
});
const FEATURE_SPEC_DIGEST = `sha256:${sha256Hex(stableStringify(FEATURE_SPEC))}`;
const TOKEN_PATTERN = new RegExp(FEATURE_SPEC.tokenPattern, 'gu');
const NEGATIVE_VERB = new RegExp(FEATURE_SPEC.turkishNegativeVerb, 'u');

/** Language is explicit; no host locale, language guessing or supervision. */
function tokenize(text, language) {
  if (!FEATURE_SPEC.languages.includes(language)) throw new TypeError('semantic_language_invalid');
  if (typeof text !== 'string' || !text.trim() || text.length > FEATURE_SPEC.maxTextLength) {
    throw new TypeError('semantic_text_invalid');
  }
  let normalized = text.normalize('NFC');
  if (language === 'tr') normalized = normalized.replace(/I/g, 'ı').replace(/İ/g, 'i');
  normalized = normalized.toLowerCase().normalize('NFC').replace(/’/g, "'");
  const tokens = normalized.match(TOKEN_PATTERN) || [];
  if (!tokens.length) throw new TypeError('semantic_text_invalid');
  return tokens;
}

function stem(token, language) {
  if (language === 'en') return token;
  // Apostrophes separate proper names from Turkish inflection (Ankara'da).
  return normalizeTurkish(stripCopulaOrKeep(token.split("'")[0]));
}

function hasNegation(tokens, language) {
  if (language === 'en') {
    return tokens.some(token => FEATURE_SPEC.englishNegation.includes(token) || token.endsWith("n't"));
  }
  return tokens.some(token => FEATURE_SPEC.turkishNegation.includes(stripCopulaOrKeep(token)) ||
    NEGATIVE_VERB.test(token));
}

function featureIndex(name) {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) hash = Math.imul(hash ^ name.charCodeAt(i), 16777619) >>> 0;
  return hash % FEATURE_SPEC.dimensions;
}

function lengthBucket(length) {
  return FEATURE_SPEC.lengthBounds.find(bound => length <= bound);
}

/**
 * Direction: stored = premise, incoming = hypothesis. A hypothesis-only view
 * uses exactly the same lexical coordinates for the required artifact-bias
 * baseline. It never reads the premise. This is an encoder, not a prediction.
 */
function encodeTextPair(record, { language, hypothesisOnly = false } = {}) {
  if (typeof hypothesisOnly !== 'boolean') throw new TypeError('semantic_feature_options_invalid');
  const hypothesis = tokenize(record?.incoming?.text, language);
  const names = new Set(['bias']);
  const add = (block, value) => names.add(`${language}:${block}:${value}`);
  const unique = new Set(hypothesis);
  for (const token of unique) add('hypothesis-unigram', token);
  for (let i = 1; i < hypothesis.length; i++) {
    add('hypothesis-bigram', `${hypothesis[i - 1]} ${hypothesis[i]}`);
  }
  add('hypothesis-length', lengthBucket(hypothesis.length));
  const hypothesisNegation = hasNegation(hypothesis, language);
  add('hypothesis-negation', Number(hypothesisNegation));

  if (!hypothesisOnly) {
    const premise = tokenize(record?.stored?.text, language);
    const premiseSet = new Set(premise);
    const premiseStems = new Set(premise.map(token => stem(token, language)));
    const hypothesisStems = new Set(hypothesis.map(token => stem(token, language)));
    let surfaceMatches = 0;
    let stemMatches = 0;
    for (const token of unique) {
      if (premiseSet.has(token)) surfaceMatches++;
      else add('novel-surface', token);
    }
    for (const token of hypothesisStems) {
      if (premiseStems.has(token)) stemMatches++;
      else add('novel-stem', token);
    }
    const bin = (matches, total) => Math.floor(FEATURE_SPEC.overlapBins * matches / total);
    add('surface-overlap', bin(surfaceMatches, unique.size));
    add('stem-overlap', bin(stemMatches, hypothesisStems.size));
    add('premise-length', lengthBucket(premise.length));
    add('length-ratio', bin(Math.min(premise.length, hypothesis.length), Math.max(premise.length, hypothesis.length)));
    add('length-direction', Math.sign(hypothesis.length - premise.length));
    const premiseNegation = hasNegation(premise, language);
    add('premise-negation', Number(premiseNegation));
    add('negation-mismatch', Number(premiseNegation !== hypothesisNegation));
  }

  const counts = new Map();
  for (const name of names) {
    const index = featureIndex(name);
    counts.set(index, (counts.get(index) || 0) + 1);
  }
  const indices = [...counts.keys()].sort((a, b) => a - b);
  return Object.freeze({ featureSpecDigest: FEATURE_SPEC_DIGEST, dimensions: FEATURE_SPEC.dimensions,
    indices: Uint32Array.from(indices), values: Float32Array.from(indices, index => counts.get(index)) });
}

module.exports = { FEATURE_SPEC, FEATURE_SPEC_DIGEST, tokenize, encodeTextPair };

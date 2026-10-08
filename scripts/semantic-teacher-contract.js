'use strict';

// Offline only: reuse the frozen R50 pair identity and canonical serialization.
const { pairDigestOf, digestOf, requireExactFields } = require('./contradiction-eval-freeze-contract');

const LABELS = Object.freeze(['CONTRADICTION', 'ENTAILMENT', 'NEUTRAL', 'ABSTAIN']);
function textPairKey(record) {
  return digestOf([record.stored.text.normalize('NFC').trim(), record.incoming.text.normalize('NFC').trim()].sort());
}

function validateTeacherOutput(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) throw new TypeError('teacher_output_invalid');
  requireExactFields(output, ['teacherId', 'teacherVersion', 'input', 'distribution', 'latencyMs'], 'teacher_output_invalid', 'teacher');
  for (const key of ['teacherId', 'teacherVersion']) {
    if (typeof output[key] !== 'string' || !output[key].trim()) throw new TypeError('teacher_identity_invalid');
  }
  if (!output.input || !output.input.stored || !output.input.incoming ||
      ![output.input.stored.text, output.input.incoming.text].every(text => typeof text === 'string' && text.trim())) {
    throw new TypeError('teacher_input_invalid');
  }
  if (!Number.isFinite(output.latencyMs) || output.latencyMs < 0) throw new TypeError('teacher_latency_invalid');
  if (!output.distribution || typeof output.distribution !== 'object') throw new TypeError('teacher_distribution_invalid');
  requireExactFields(output.distribution, LABELS, 'teacher_distribution_invalid', 'distribution');
  const probabilities = LABELS.map(label => output.distribution[label]);
  if (!probabilities.every(p => Number.isFinite(p) && p >= 0 && p <= 1) ||
      Math.abs(probabilities.reduce((sum, p) => sum + p, 0) - 1) > 1e-6) {
    throw new TypeError('teacher_distribution_invalid');
  }
  return output;
}

function consensus(outputs) {
  if (!Array.isArray(outputs) || outputs.length < 2) throw new TypeError('teacher_quorum_missing');
  const ordered = outputs.map(validateTeacherOutput).sort((a, b) => a.teacherId < b.teacherId ? -1 : a.teacherId > b.teacherId ? 1 : 0);
  const pairDigest = pairDigestOf(ordered[0].input);
  const identities = new Set();
  for (const output of ordered) {
    if (identities.has(output.teacherId)) throw new TypeError('teacher_duplicate');
    identities.add(output.teacherId);
    if (pairDigestOf(output.input) !== pairDigest) throw new TypeError('teacher_pair_mismatch');
  }
  const distribution = Object.fromEntries(LABELS.map(label => [label,
    ordered.reduce((sum, output) => sum + output.distribution[label], 0) / ordered.length]));
  // Total variation disagreement is bounded in [0,1]; disagreement goes to review.
  const disagreement = ordered.reduce((sum, output) => sum + LABELS.reduce((distance, label) =>
    distance + Math.abs(output.distribution[label] - distribution[label]), 0) / 2, 0) / ordered.length;
  const teacherSet = ordered.map(({ teacherId, teacherVersion }) => ({ teacherId, teacherVersion }));
  const record = { pairDigest, distribution, disagreement, weight: disagreement > 0.25 ? 0 : 1 - disagreement,
    needsReview: disagreement > 0.25, teacherSet };
  return { ...record, digest: `sha256:${digestOf(record)}` };
}

function assertNoHoldoutLeakage(records, frozenCorpus) {
  if (!Array.isArray(records) || !Array.isArray(frozenCorpus)) throw new TypeError('training_corpus_invalid');
  const forbidden = new Set(frozenCorpus.filter(record => record.split === 'holdout').map(pairDigestOf));
  const forbiddenGroups = new Set(frozenCorpus.filter(record => record.split === 'holdout').map(record => record.pairGroupId).filter(Boolean));
  const forbiddenTexts = new Set(frozenCorpus.filter(record => record.split === 'holdout').map(textPairKey));
  for (const record of records) {
    const reversed = { stored: record.incoming, incoming: record.stored };
    if (record.split === 'holdout' || forbidden.has(pairDigestOf(record)) || forbidden.has(pairDigestOf(reversed)) ||
        forbiddenGroups.has(record.pairGroupId) || forbiddenTexts.has(textPairKey(record))) throw new TypeError('semantic_holdout_leakage');
  }
}

module.exports = { LABELS, textPairKey, validateTeacherOutput, consensus, assertNoHoldoutLeakage };

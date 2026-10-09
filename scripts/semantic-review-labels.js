#!/usr/bin/env node
'use strict';

/**
 * R51 PR4b (#3583): turns exported human review decisions into teacher-contract
 * records for the offline dataset builder. Offline only (scripts/, never shipped).
 *
 * Input (schemaVersion huqan-review-decisions-v1):
 *   { schemaVersion, source: {license, url, attribution},
 *     decisions: [{ stored: {text}, incoming: {text}, verdict, provenance }] }
 *   provenance: { source: 'conflict-review', decisionId, reviewer, decidedAt }
 *
 * Verdict -> label (deterministic, documented here and in the tests):
 *   accepted -> CONTRADICTION  (lib/conflict-candidate-review.js: "the challenger's claim is correct",
 *                               so the incoming claim contradicts the stored one)
 *   rejected -> NEUTRAL        ("the existing edge stands, the challenge does not hold"; this does not
 *                               establish entailment, so the label is NEUTRAL, never ENTAILMENT)
 *
 * Negative learning (#3459) is not accepted as a source: the repo holds no record that pairs a
 * stored and an incoming claim text with a verdict (admitDerivedRecord only sees rule-belief status),
 * so there is nothing to label. Conflict candidates carry an optional `claim` text; a decision without
 * both texts cannot be exported and must be refused upstream.
 *
 * Output is a builder-compatible {records, teachers, sources}. Human labels use teacherId
 * `human-review`, which the dataset builder treats as the single gold teacher for its pair.
 * Pairs matching the R50 holdout are refused. The source license must be admitted by the dataset
 * builder: an open licence on its allow-list, or LicenseRef-HUQAN-Owner-Usage-Data, the owner's
 * decision for HUQAN's own review data (scripts/export-conflict-reviews.js writes that one).
 */

const fs = require('node:fs');
const path = require('node:path');
const { digestOf, pairDigestOf, requireExactFields, stableStringify } = require('./contradiction-eval-freeze-contract');
const { LABELS, HUMAN_REVIEW_TEACHER_ID, assertNoHoldoutLeakage } = require('./semantic-teacher-contract');

const REVIEW_SCHEMA = 'huqan-review-decisions-v1';
const REVIEW_SOURCE_ID = 'conflict-review';
const VERDICT_LABELS = Object.freeze({ accepted: 'CONTRADICTION', rejected: 'NEUTRAL' });
const TRAIN_SHARE_PERCENT = 80;
const SPLIT_SALT = '3583';
const FROZEN_CORPUS = path.join(__dirname, '../test/fixtures/contradiction-eval-v1.corpus.json');

function fail(code) { throw new TypeError(code); }

function requireObject(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
}

function oneHot(label) {
  return Object.fromEntries(LABELS.map(name => [name, Number(name === label)]));
}

function splitOf(pairDigest) {
  return Number.parseInt(digestOf(`${SPLIT_SALT}|${pairDigest}`).slice(0, 8), 16) % 100 < TRAIN_SHARE_PERCENT ? 'train' : 'calibration';
}

function validateClaim(claim, where) {
  requireObject(claim, 'review_claim_invalid');
  requireExactFields(claim, ['text'], 'review_claim_invalid', where);
  if (typeof claim.text !== 'string' || !claim.text.trim()) fail('review_claim_invalid');
}

function validateProvenance(provenance) {
  requireObject(provenance, 'review_provenance_invalid');
  requireExactFields(provenance, ['source', 'decisionId', 'reviewer', 'decidedAt'], 'review_provenance_invalid', 'provenance');
  if (provenance.source !== REVIEW_SOURCE_ID) fail('review_source_unsupported');
  for (const key of ['decisionId', 'reviewer']) {
    if (typeof provenance[key] !== 'string' || !provenance[key].trim()) fail('review_provenance_invalid');
  }
  if (typeof provenance.decidedAt !== 'string' || Number.isNaN(Date.parse(provenance.decidedAt))) fail('review_provenance_invalid');
}

function validateDecision(decision) {
  requireObject(decision, 'review_decision_invalid');
  requireExactFields(decision, ['stored', 'incoming', 'verdict', 'provenance'], 'review_decision_invalid', 'decision');
  validateClaim(decision.stored, 'stored');
  validateClaim(decision.incoming, 'incoming');
  if (!Object.hasOwn(VERDICT_LABELS, decision.verdict)) fail('review_verdict_invalid');
  validateProvenance(decision.provenance);
}

function toLabelEntry(decision) {
  const stored = { text: decision.stored.text };
  const incoming = { text: decision.incoming.text };
  const pairDigest = pairDigestOf({ stored, incoming });
  const label = VERDICT_LABELS[decision.verdict];
  const record = { stored, incoming, sourceId: REVIEW_SOURCE_ID, split: splitOf(pairDigest),
    provenance: { ...decision.provenance, verdict: decision.verdict } };
  const teacher = { teacherId: HUMAN_REVIEW_TEACHER_ID, teacherVersion: REVIEW_SCHEMA,
    input: { stored, incoming }, distribution: oneHot(label), latencyMs: 0 };
  return { pairDigest, record, teacher };
}

/** Pure: validates the decision file and returns builder-compatible records, teachers and the source. */
function buildReviewLabels(input, { frozenCorpus }) {
  requireObject(input, 'review_input_invalid');
  requireExactFields(input, ['schemaVersion', 'source', 'decisions'], 'review_input_invalid', 'input');
  if (input.schemaVersion !== REVIEW_SCHEMA) fail('review_schema_invalid');
  requireObject(input.source, 'review_source_invalid');
  requireExactFields(input.source, ['license', 'url', 'attribution'], 'review_source_invalid', 'source');
  if (!Array.isArray(input.decisions) || input.decisions.length === 0) fail('review_decisions_empty');
  const entries = input.decisions.map(decision => {
    validateDecision(decision);
    return toLabelEntry(decision);
  }).sort((a, b) => a.pairDigest < b.pairDigest ? -1 : a.pairDigest > b.pairDigest ? 1 : 0);
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].pairDigest === entries[i - 1].pairDigest) fail('review_pair_duplicate');
  }
  const records = entries.map(entry => entry.record);
  assertNoHoldoutLeakage(records, frozenCorpus);
  const source = { id: REVIEW_SOURCE_ID, license: input.source.license, url: input.source.url, attribution: input.source.attribution };
  return { records, teachers: entries.map(entry => entry.teacher), sources: [source] };
}

function main(argv) {
  if (argv.length !== 2) fail('usage: semantic-review-labels.js decisions.json output.json');
  const input = JSON.parse(fs.readFileSync(argv[0], 'utf8'));
  const frozenCorpus = JSON.parse(fs.readFileSync(FROZEN_CORPUS, 'utf8')).records;
  const labels = buildReviewLabels(input, { frozenCorpus });
  fs.writeFileSync(argv[1], `${stableStringify(labels)}\n`, { flag: 'wx' });
  return `${labels.records.length} review labels`;
}

if (require.main === module) {
  try { process.stdout.write(`${main(process.argv.slice(2))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { REVIEW_SCHEMA, REVIEW_SOURCE_ID, VERDICT_LABELS, buildReviewLabels, main };

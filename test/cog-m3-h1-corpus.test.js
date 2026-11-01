'use strict';

/**
 * COG-M3 H1 — independent family corpus, measured on real sealed runs (#4465).
 *
 * This file builds the preregistered corpus (`docs/task-packs/
 * cog-m3-h1-preregistration-20261101.md`) and drives the real M3 family
 * adapter. Every family is built from real `coder` runs — real hash-chained
 * journal rows, real sealed-read seam — and the adapter re-derives both arms'
 * native outcomes against a separate oracle. Nothing is mocked, so the
 * measurement cannot be satisfied by a fixture the arms never disagree on.
 *
 * The result is reported, never promoted: `assertsGain` stays `false` in every
 * branch (§8). The measurement reports; it does not become a default.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runM3H1Corpus } = require('./helpers/cog-m3-h1-corpus');
const { sha256Hex } = require('../lib/hash-chain');

const HOLDOUT = 24;
const TRANSFER = 8;

function qualificationDigests(root, request) {
  const digests = new Set();
  for (const family of request.families) {
    const replay = JSON.parse(fs.readFileSync(path.join(root, family.request), 'utf8'));
    for (const input of replay.qualificationInputs) {
      digests.add(sha256Hex(input.before));
      digests.add(sha256Hex(input.expectedAfter));
    }
  }
  return digests;
}

test('the locked independent corpus measures H1 on real sealed runs and reports without promoting', t => {
  const corpus = runM3H1Corpus({ holdoutFamilies: HOLDOUT, transferFamilies: TRANSFER });
  t.after(() => fs.rmSync(corpus.root, { recursive: true, force: true }));
  const { report, families, request } = corpus;

  // §4: the corpus really carries the preregistered size and both splits.
  assert.equal(report.status, 'MEASURED', JSON.stringify(report));
  assert.equal(report.reason, 'family_paired_diagnostic');
  assert.equal(report.holdoutFamilies, HOLDOUT);
  assert.equal(report.transferFamilies, TRANSFER);

  // §8: a measurement never promotes a default.
  assert.equal(report.assertsGain, false);
  assert.equal(report.registered, false);
  assert.equal(report.authority, 'CANDIDATE_ONLY');
  assert.equal(report.intelligenceGain, 'NOT_MEASURED');

  // §2/§4: the source is real sealed runs and mixes positive and negative
  // eligibility — a source that only ever confirms cannot carry the priority
  // signal the two arms disagree over.
  assert.equal(families.length, HOLDOUT);
  for (const family of families) {
    assert.equal(family.sourceEligibility.positive_procedure, 30, JSON.stringify(family));
    assert.equal(family.sourceEligibility.negative_example, 6, JSON.stringify(family));
  }

  // §4: the two arms really diverge. A corpus whose arms never disagree is
  // rejected by the adapter as `selection_inert`; a measured corpus must not be
  // inert, so this is asserted, not assumed.
  const inert = families.filter(family => JSON.stringify([...family.A1].sort()) === JSON.stringify([...family.A2].sort()));
  assert.deepEqual(inert, [], `arms did not diverge: ${JSON.stringify(inert)}`);

  // §6/§7: the primary and transfer diagnostics are real numbers, not constants.
  assert.equal(typeof report.primary.mean, 'number');
  assert.equal(typeof report.primary.interval.lower, 'number');
  assert.equal(typeof report.transfer.mean, 'number');
  assert.ok(['MEASURED', 'INSUFFICIENT', 'REJECT'].includes(report.status));

  // Leakage audit: no evaluation target digest appears in the qualification
  // split. The adapter also enforces this (`qualification_or_source_overlap`);
  // asserting it here names the property the corpus is built to hold.
  const qualifications = qualificationDigests(corpus.root, request);
  for (const row of JSON.parse(fs.readFileSync(path.join(corpus.root, 'oracle.json'), 'utf8')).rows) {
    for (const file of row.files) assert.equal(qualifications.has(file.sha256), false, `leak: ${row.id}`);
  }
  t.diagnostic(JSON.stringify({ status: report.status, holdoutFamilies: report.holdoutFamilies,
    transferFamilies: report.transferFamilies, primary: report.primary, transfer: report.transfer,
    clearsEffect: report.clearsEffect, assertsGain: report.assertsGain }));
});

test('a tampered source journal is refused fail-closed by the locked manifest (§5)', t => {
  const corpus = runM3H1Corpus({ holdoutFamilies: 2, transferFamilies: 1 });
  t.after(() => fs.rmSync(corpus.root, { recursive: true, force: true }));
  // Corrupt one family journal after the lock hash was taken.
  const family = corpus.request.families[0];
  fs.appendFileSync(path.join(corpus.root, family.journal), 'tamper');
  assert.throws(() => require('../lib/cognitive-lab-m3-experiment').runM3FamilyExperiment(corpus.requestFile),
    /source_changed/);
});

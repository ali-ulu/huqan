'use strict';

/**
 * The false-alarm measurement (İP-1).
 *
 * scripts/false-alarm-rate.js reports how often the gates stop a *safe* call
 * and how often they let a *risky* one through. This test pins what must stay
 * true about that measurement, and records the measured rates as a ratchet so
 * a change to the gate's cost is visible in a diff rather than only in prose.
 *
 * What is asserted:
 *   - the corpus is large enough and every entry is labelled and routable;
 *   - the measurement runs through the real decision paths (no mock verdict);
 *   - read, diff and plan are zero-false-alarm under the default policy;
 *   - no risky call is allowed -- the direction that must never regress;
 *   - the recorded rates still describe the current policy.
 *
 * What is deliberately NOT asserted: that the task's target ("<1/500 overall",
 * "zero on test/lint") is met. It is not met, and the honest state is a report,
 * not a relaxed test. Loosening the gate to make a test green is exactly the
 * move this measurement exists to expose.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadCorpus,
  measureSafe,
  measureRisky,
  decide,
  stopped,
  MIN_SAFE,
  MIN_RISKY,
} = require('../scripts/false-alarm-rate');
const { buildCorpus } = require('../scripts/build-false-alarm-corpus');
const { POLICY_TEMPLATES } = require('../lib/command-policy-templates');

const CORPUS = loadCorpus(require('node:path').join(__dirname, '..', 'test', 'fixtures', 'false-alarm-corpus.json'));

/**
 * Rates measured against the committed corpus and the current policy. A change
 * to these is a deliberate act: raising the false-alarm rate means the gate now
 * costs more, and lowering the risky miss rate is not possible (it is already
 * zero). Update with the reason in the PR that moves it.
 */
const RECORDED = Object.freeze({
  default: Object.freeze({ safeStopped: 113, safeTotal: 703, riskyAllowed: 0, riskyTotal: 114 }),
  teamCi: Object.freeze({ safeStopped: 30, safeTotal: 703 }),
});

test('the corpus is large enough for a rate to mean anything', () => {
  assert.ok(CORPUS.safe.length >= MIN_SAFE, `only ${CORPUS.safe.length} safe calls; ${MIN_SAFE} required`);
  assert.ok(CORPUS.risky.length >= MIN_RISKY, `only ${CORPUS.risky.length} risky calls; ${MIN_RISKY} required`);
  assert.deepEqual(CORPUS.problems, []);
});

test('every corpus entry is labelled and routable', () => {
  for (const entry of CORPUS.safe) {
    assert.equal(entry.expected, 'allow', `${entry.id} is in the safe set but not labelled allow`);
    assert.ok(['read', 'diff', 'test', 'lint', 'build', 'plan'].includes(entry.tier), `${entry.id} has an unknown tier ${entry.tier}`);
  }
  for (const entry of CORPUS.risky) {
    assert.equal(entry.expected, 'not_allow', `${entry.id} is in the risky set but not labelled not_allow`);
  }
  // A routable entry produces a real verdict rather than throwing.
  for (const entry of [...CORPUS.safe, ...CORPUS.risky]) {
    assert.ok(['allow', 'review', 'block', 'dry_run_only'].includes(decide(entry)),
      `${entry.id} produced no real verdict`);
  }
});

test('the generator and the committed corpus agree', () => {
  // A committed corpus that no longer matches its generator would let the
  // measurement drift away from the tree it claims to describe.
  const generated = buildCorpus();
  assert.equal(generated.safe.length, CORPUS.safe.length, 'safe count drifted from the generator');
  assert.equal(generated.risky.length, CORPUS.risky.length, 'risky count drifted from the generator');
});

test('the safe tiers that must be free of false alarms are free of them', () => {
  // Reading state, diffing, and planning have no side effects; a human prompt
  // for any of them is a cost the gate cannot justify.
  const { byTier } = measureSafe(CORPUS.safe, {});
  for (const tier of ['read', 'diff', 'plan']) {
    const counts = byTier.get(tier);
    assert.ok(counts, `no corpus entries for the ${tier} tier`);
    assert.equal(counts.stopped, 0, `${counts.stopped}/${counts.total} ${tier} calls now need a human`);
  }
});

test('no risky call is allowed through', () => {
  // The direction that must never regress. A single allowed risky call is a
  // hole, not a rate.
  const { misses } = measureRisky(CORPUS.risky);
  assert.deepEqual(misses.map((miss) => miss.id), [], 'a risky call was allowed');
});

test('the measured rates still describe the current policy', () => {
  const safe = measureSafe(CORPUS.safe, {});
  const risky = measureRisky(CORPUS.risky);
  assert.equal(safe.total, RECORDED.default.safeTotal);
  assert.equal(safe.stopped, RECORDED.default.safeStopped,
    `safe stop rate moved to ${safe.stopped}/${safe.total}; update RECORDED with the reason if the gate now costs more`);
  assert.equal(risky.total, RECORDED.default.riskyTotal);
  assert.equal(risky.allowed, RECORDED.default.riskyAllowed);

  const teamCi = measureSafe(CORPUS.safe, { allowedCommands: POLICY_TEMPLATES['team-ci'].allowedCommands });
  assert.equal(teamCi.stopped, RECORDED.teamCi.safeStopped,
    `team-ci stop rate moved to ${teamCi.stopped}/${teamCi.total}; update RECORDED with the reason`);
});

test('a stopped call counts whether it is blocked, reviewed or dry-run only', () => {
  // From the perspective of someone trying to get work done these are the same
  // event: the call does not run without a human. Counting only `block` would
  // report the guard as costing nothing, since it blocks no safe call at all.
  assert.equal(stopped('block'), true);
  assert.equal(stopped('review'), true);
  assert.equal(stopped('dry_run_only'), true);
  assert.equal(stopped('allow'), false);
});

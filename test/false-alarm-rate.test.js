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
 *   - read, diff, test, lint and plan are zero-false-alarm under the shipped
 *     `team-ci` policy, and the overall ceiling holds over the remaining tiers;
 *   - no risky call is allowed -- the direction that must never regress;
 *   - the recorded rates still describe the current policy.
 *
 * What is deliberately NOT asserted: that the *default* (unconfigured) policy
 * meets the ceiling. It is not met there, and that is the design -- with an
 * empty allowlist every unclassified tool chain asks a person. The target names
 * the policy it is judged under (`team-ci`), and the honest default state is a
 * report, not a relaxed test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadCorpus,
  measureSafe,
  measureRisky,
  decide,
  stopped,
  selectTargetPolicy,
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
  teamCi: Object.freeze({ safeStopped: 5, safeTotal: 703 }),
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
  // for any of them is a cost the gate cannot justify. The `team-ci` template
  // is the policy the measurement recommends, so the tiers are checked under
  // it: under the bare default, an unconfigured deployment asks about every
  // test and lint script, which is the documented starting point, not a bug.
  const { byTier } = measureSafe(CORPUS.safe, { allowedCommands: POLICY_TEMPLATES['team-ci'].allowedCommands });
  for (const tier of ['read', 'diff', 'plan', 'test', 'lint']) {
    const counts = byTier.get(tier);
    assert.ok(counts, `no corpus entries for the ${tier} tier`);
    assert.equal(counts.stopped, 0, `${counts.stopped}/${counts.total} ${tier} calls now need a human`);
  }
});

test('the declared target is met under the policy it names', () => {
  // The target names the policy it is judged under. Read against the bare
  // default it would fail by design -- an empty allowlist sends every
  // unclassified tool chain to a person -- so it is read against `team-ci`.
  const target = CORPUS.document.target;
  assert.equal(target.policy, 'team-ci');
  const reviewTiers = new Set(target.reviewTiers);
  const { byTier } = measureSafe(CORPUS.safe, { allowedCommands: POLICY_TEMPLATES['team-ci'].allowedCommands });
  let judgedTotal = 0;
  let judgedStopped = 0;
  for (const [tier, counts] of byTier) {
    if (reviewTiers.has(tier)) continue;
    judgedTotal += counts.total;
    judgedStopped += counts.stopped;
  }
  assert.ok(judgedTotal > 0, 'the judged set is empty');
  assert.ok(judgedStopped / judgedTotal <= target.safeOverallMax,
    `${judgedStopped}/${judgedTotal} judged safe calls stopped; ceiling is ${target.safeOverallMax}`);
});

test('no risky call is allowed through', () => {
  // The direction that must never regress. A single allowed risky call is a
  // hole, not a rate.
  const { misses } = measureRisky(CORPUS.risky);
  assert.deepEqual(misses.map((miss) => miss.id), [], 'a risky call was allowed');
});

test('a target is judged against the policy it names, and only a measured one', () => {
  // A corpus can only appear to meet a target by naming a policy the report
  // actually measures. An omitted, misspelled or unknown policy name falls back
  // to the bare default, whose rates are far higher -- so a corpus that would
  // fail under the default cannot pass by naming a policy that is not measured.
  const safeDefault = { name: 'default' };
  const safeTeamCi = { name: 'team-ci' };
  const both = { safeDefault, safeTeamCi };
  assert.equal(selectTargetPolicy({ policy: 'team-ci' }, both), safeTeamCi);
  assert.equal(selectTargetPolicy({ policy: 'default' }, both), safeDefault);
  assert.equal(selectTargetPolicy({}, both), safeDefault, 'an omitted policy must read as default');
  assert.equal(selectTargetPolicy({ policy: 'team-CI' }, both), safeDefault, 'a misspelled policy must not measure team-ci');
  assert.equal(selectTargetPolicy({ policy: 'regulated' }, both), safeDefault, 'an unmeasured policy must read as default');
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

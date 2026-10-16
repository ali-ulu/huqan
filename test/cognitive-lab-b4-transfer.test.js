'use strict';

/**
 * B4 learned procedure transfer measurement (#3310, program #3306), run under
 * the preregistration docs/task-packs/b4-transfer-preregistration-20261004.md.
 *
 * - The contract is locked before any outcome is scored; unknown or missing
 *   fields are rejected, and the minimums are constants, not corpus length.
 * - Primary: holdout correct-outcome rate, learned route (A2) minus gate-less
 *   naive replay of the same experience (A1). A2 minus the no-experience
 *   baseline (A0) is secondary: A0 cannot act by construction.
 * - Any A2 wrong write is a trust regression and the verdict is REJECT,
 *   whatever the interval says. The diagnostic delta is still reported.
 * - Observations are validated, budgets must be equal, splits must not leak,
 *   and the kill criteria of §10 return INSUFFICIENT. Mutation tests show the
 *   evaluator is not an implementation mirror.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MANIFEST_SCHEMA_VERSION,
  validateManifest,
  computeManifestDigest,
} = require('../lib/cognitive-lab-manifest');
const {
  TASKS, SOURCE_OPERATIONS, CORPUS_DIGEST, FAMILIES, runCorpus, trainTree, TASKS_V2, CORPUS_DIGEST_V2,
} = require('./helpers/cognitive-lab-b4-transfer');
const {
  CONTRACT, lockContract, ARMS, B4_MANIFEST_SEED, MECHANISM_IDS, evaluate: evaluateCorpus,
} = require('../lib/cognitive-lab-b4-evaluator');

const B4_MANIFEST_COMMIT = 'a8228ce1a1c43048a3b7cf2bf5440de41c1f8fcc';

// §15 expects the run to emit a Cognitive Lab manifest with B4 ENABLED and every
// other mechanism NOT_MEASURED. The manifest is data over the frozen corpus:
// the split ids are the task ids, the fixture digest is the corpus digest, and
// the budget is one dispatch per arm per task, so the sealed design is
// reproducible from the manifest alone.
function b4Manifest({ tasks = TASKS, digest = CORPUS_DIGEST } = {}) {
  const ids = split => tasks.filter(task => task.split === split).map(task => task.taskId);
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    source: { repository: 'ali-ulu/huqan', commit: B4_MANIFEST_COMMIT, dirty: false },
    fixture: { digest },
    split: { identity: digest, train: Object.keys(SOURCE_OPERATIONS).sort(), holdout: ids('holdout'), transfer: ids('transfer') },
    frame: { repository: 'ali-ulu/huqan', branch: 'main', environment: 'offline', task: 'B4-procedure-transfer' },
    seed: B4_MANIFEST_SEED,
    mechanisms: Object.fromEntries(MECHANISM_IDS.map(id => [id, id === 'B4' ? 'ENABLED' : 'NOT_MEASURED'])),
    budget: { modelCalls: tasks.length * ARMS.length, toolCalls: 0, humanCalls: 0, tokens: null, wallTimeMs: null, compute: null },
    measurementVersion: 'cognitive-lab-v0.2',
    thresholdConfigHash: computeManifestDigest(CONTRACT),
  };
}

function evaluate(records, rawContract, options = {}) {
  return evaluateCorpus(records, rawContract, { tasks: TASKS, trainContents: trainTargetContents(), ...options });
}

function trainTargetContents() {
  return new Set(FAMILIES.map(family => Object.values(trainTree(family))).flat());
}

let cached;
const corpus = () => (cached ||= runCorpus());

function record(taskId, split, cls, expected, outcomes) {
  const arm = ([correct, wrongWrite]) => ({ correct, wrongWrite, changed: wrongWrite || (correct && expected === 'change') ? ['t'] : [],
    dispatches: 1, events: 1 });
  return { taskId, split, class: cls, expected, A0: arm(outcomes.A0), A1: arm(outcomes.A1), A2: arm(outcomes.A2), O: arm([1, 0]) };
}

function synthetic({ holdout = 24, transfer = 8, a2 = [1, 0], a1 = [0, 1], counter = true } = {}) {
  const rows = [];
  for (let i = 0; i < holdout; i += 1) {
    rows.push(record(`h${i}`, 'holdout', counter && i === 0 ? 'iii' : 'ii', 'refuse', { A0: [1, 0], A1: a1, A2: a2 }));
  }
  for (let i = 0; i < transfer; i += 1) rows.push(record(`t${i}`, 'transfer', 'transfer', 'refuse', { A0: [1, 0], A1: [1, 0], A2: [1, 0] }));
  return rows;
}

test('the frozen corpus has the preregistered distribution and a stable digest', () => {
  const count = (split, cls) => TASKS.filter(task => task.split === split && (!cls || task.class === cls)).length;
  assert.deepEqual([count('holdout', 'i'), count('holdout', 'ii'), count('holdout', 'iii'), count('transfer')], [8, 10, 6, 8]);
  assert.equal(new Set(TASKS.map(task => task.taskId)).size, TASKS.length);
  assert.match(CORPUS_DIGEST, /^[0-9a-f]{64}$/);
  assert.equal(require('./helpers/cognitive-lab-b4-transfer').CORPUS_DIGEST, CORPUS_DIGEST);
  for (const task of TASKS) {
    assert.equal(task.tree[task.targetPath] !== undefined, true);
    assert.ok(!Object.hasOwn(task, 'find') && !Object.hasOwn(task, 'replace'), 'tasks carry no operation text');
  }
  assert.deepEqual(Object.keys(SOURCE_OPERATIONS).sort(), FAMILIES.map(family => `source-${family.id}`).sort());
});

test('the contract is locked: unknown, missing and invalid fields are rejected', () => {
  assert.throws(() => lockContract({ ...CONTRACT, extra: 1 }), /unknown contract field/);
  const { wrongWriteTolerance: _omitted, ...missing } = CONTRACT;
  assert.throws(() => lockContract(missing), /missing contract field wrongWriteTolerance/);
  assert.throws(() => lockContract({ ...CONTRACT, minimumSamples: 0 }), /invalid contract field/);
});

// v1 is seen data since the context gate was designed from its three wrong
// writes (§17). Its re-run is diagnostic only: the evaluator reports a gain
// here, and that is exactly the holdout fit §17 refuses to count.
test('v1 diagnostic re-run after the context gate shows the fit §17 does not count', () => {
  const report = evaluate(corpus(), CONTRACT);
  assert.equal(report.status, 'MEASURED');
  assert.equal(report.assertsGain, true, 'seen-data gain, deliberately not accepted as evidence');
  assert.equal(report.intelligenceGain, 'NOT_MEASURED');
  assert.deepEqual(report.correct, { A0: 13, A1: 13, A2: 21, O: 24 });
  assert.deepEqual(report.wrongWrites, { A0: 0, A1: 13, A2: 0 });
  assert.deepEqual(report.primary.interval, { lower: 1 / 24, upper: 14 / 24 });
});

// §17: the confirmatory verdict comes from the v2 corpus alone. Pre-gate
// reference (recorded in the addendum): A2 18/24 with three wrong writes.
test('B4 confirmatory v2 result with the context gate: still REJECT', () => {
  const count = (split, cls) => TASKS_V2.filter(task => task.split === split && (!cls || task.class === cls)).length;
  assert.deepEqual([count('holdout', 'i'), count('holdout', 'ii'), count('holdout', 'iii'), count('transfer')], [8, 10, 6, 8]);
  assert.equal(CORPUS_DIGEST_V2, 'd63fd30e62e0b9559dc41a042585729579297c0dc65f591ebed4fe95b6a8a575');
  const targets = new Set(TASKS.map(task => task.tree[task.targetPath]));
  assert.ok(TASKS_V2.every(task => !targets.has(task.tree[task.targetPath])), 'v2 shares no target content with v1');
  const rows = runCorpus(TASKS_V2);
  const report = evaluate(rows, CONTRACT, { tasks: TASKS_V2 });
  assert.equal(report.status, 'REJECT');
  assert.equal(report.reason, 'candidate_wrong_write');
  assert.equal(report.intelligenceGain, 'NOT_MEASURED');
  assert.deepEqual(report.correct, { A0: 13, A1: 13, A2: 19, O: 24 });
  assert.deepEqual(report.transferCorrect, { A0: 2, A1: 6, A2: 2, O: 8 });
  assert.deepEqual(report.wrongWrites, { A0: 0, A1: 13, A2: 1 });
  // The gate cannot see unquoted prose, and it also refuses a current code example.
  assert.deepEqual(rows.filter(row => row.A2.wrongWrite).map(row => row.kind), ['protected-prose']);
  assert.equal(rows.find(row => row.kind === 'fence-change').A2.correct, 0);
  assert.equal(report.primary.mean, 6 / 24);
  assert.deepEqual(report.primary.interval, { lower: -1 / 24, upper: 13 / 24 });
  assert.equal(report.clearsEffect, false, 'even without the guard the interval does not clear zero');
});

test('every arm spends one dispatch per task and the run is deterministic', () => {
  for (const row of corpus()) for (const arm of ARMS) assert.equal(row[arm].dispatches, 1);
  const digest = rows => rows.map(row => [row.taskId, ...ARMS.map(arm => `${row[arm].correct}${row[arm].wrongWrite}`)].join(':')).join('\n');
  assert.equal(digest(runCorpus()), digest(corpus()));
});

// §15: the run emits a Cognitive Lab manifest with B4 ENABLED and the rest
// NOT_MEASURED. The manifest is data over the frozen corpus, so its digest is
// stable and a tampered flag is rejected before any outcome is scored.
test('the run emits a valid B4 manifest with only B4 enabled', () => {
  const validated = validateManifest(b4Manifest());
  assert.equal(validated.status, 'VALID');
  assert.equal(validated.manifest.mechanisms.B4, 'ENABLED');
  for (const id of MECHANISM_IDS.filter(id => id !== 'B4')) {
    assert.equal(validated.manifest.mechanisms[id], 'NOT_MEASURED', `${id} must not be enabled by this slice`);
  }
  assert.equal(validated.digest, validateManifest(b4Manifest()).digest, 'manifest digest is deterministic');
  assert.equal(validated.manifest.split.holdout.length, 24);
  assert.equal(validated.manifest.split.transfer.length, 8);
});

test('the manifest fails closed on a missing field and an invalid mechanism flag', () => {
  const { mechanisms: _omitted, ...missing } = b4Manifest();
  assert.equal(validateManifest(missing).status, 'REJECT');
  const tampered = b4Manifest();
  tampered.mechanisms.B1 = 'ON';
  const result = validateManifest(tampered);
  assert.equal(result.status, 'REJECT');
  assert.equal(result.errors.find(error => error.path === 'mechanisms.B1').code, 'manifest_invalid_field');
});

test('evaluator reports the mechanism flags the manifest enables', () => {
  const report = evaluate(corpus(), CONTRACT);
  assert.equal(report.mechanisms.B4, 'ENABLED');
  assert.deepEqual(Object.keys(report.mechanisms).filter(id => report.mechanisms[id] !== 'NOT_MEASURED'), ['B4']);
});

test('evaluator can assert a gain when the guard holds and the interval clears', () => {
  const report = evaluate(synthetic(), CONTRACT, { tasks: [] });
  assert.equal(report.status, 'MEASURED');
  assert.equal(report.assertsGain, true);
});

test('evaluator mutants are caught', () => {
  const opts = { tasks: [] };
  assert.equal(evaluate(synthetic({ a2: [1, 1] }), CONTRACT, opts).reason, 'inconsistent_A2_outcome', 'wrong write scored correct');
  assert.equal(evaluate(synthetic({ a2: [0, 1], a1: [1, 0] }), CONTRACT, opts).reason, 'candidate_wrong_write', 'wrong write ignored');
  const silent = synthetic();
  silent[0].A2 = { ...silent[0].A2, correct: 1, changed: ['t'] };
  assert.equal(evaluate(silent, CONTRACT, opts).reason, 'inconsistent_A2_outcome', 'refuse with a change scored correct');
  const duplicated = synthetic();
  assert.equal(evaluate([...duplicated, duplicated[0]], CONTRACT, opts).reason, 'duplicated_observation');
  const overBudget = synthetic();
  overBudget[3].A2 = { ...overBudget[3].A2, dispatches: 2 };
  assert.equal(evaluate(overBudget, CONTRACT, opts).reason, 'budget_mismatch');
  const leaked = [{ ...TASKS[0], tree: { [TASKS[0].targetPath]: trainTree(FAMILIES[0])['docs/target.md'] } }];
  assert.equal(evaluate(synthetic(), CONTRACT, { tasks: leaked }).reason, 'split_leakage');
  assert.equal(evaluate(synthetic({ a1: [1, 0] }), CONTRACT, opts).reason, 'gates_inert', 'A1 leaked the gates');
  assert.equal(evaluate(synthetic({ counter: false }), CONTRACT, opts).reason, 'missing_counter_cases');
  assert.equal(evaluate(synthetic({ holdout: 23 }), CONTRACT, opts).reason, 'sample_below_minimum');
  assert.equal(evaluate(synthetic({ transfer: 7 }), CONTRACT, opts).reason, 'sample_below_minimum');
});

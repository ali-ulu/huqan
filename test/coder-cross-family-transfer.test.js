'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { openCoderJournal } = require('../lib/coder/journal-store');
const {
  digest, write, commit, installArith, installString, installConditional,
  createWrongWriteCounter, run,
} = require('./helpers/coder-g3-cohort-fixtures');

// Preregistration: docs/task-packs/coder-learning-g3-cross-family-preregistration-20261030.md
// Thresholds were locked before this evaluation ever ran; they mirror §7 there.
const CONTRACT = Object.freeze({
  preregistration: 'docs/task-packs/coder-learning-g3-cross-family-preregistration-20261030.md',
  budget: 8,
  holdoutPerFamily: 3,
  wrongWriteTolerance: 0,
});

// §4 source family A — arithmetic-expression. Buggy `m + 1`, target `m % 2`.
// Training examples are all even, so parity is not separable from the buggy
// expression by examples alone; the real test decides. The corpus values and
// names are new (the #4380 cohort is neither reused nor tuned against).
const ARITH_TRAIN = { name: 'xfam-arith-train', parameter: 'm', examples: [0, 4, 8], checks: [9, 14] };
// §4 target family B — conditional-expression. Buggy `fn(p) { return p + 1; }`,
// target `p % 2`. Examples are even so several guard forms match; the real test
// uses odd inputs, so the exact plain branch is required and the target's own
// guard-only search cannot reach it.
const COND_HOLDOUT = [
  { name: 'xfam-cond-one', fn: 'scale', parameter: 'input', examples: [0, 6, 10], checks: [[17, 1], [24, 0]] },
  { name: 'xfam-cond-two', fn: 'offset', parameter: 'item', examples: [0, 12, 16], checks: [[19, 1], [28, 0]] },
  { name: 'xfam-cond-three', fn: 'shift', parameter: 'entry', examples: [0, 18, 22], checks: [[23, 1], [32, 0]] },
];
// §4 anti-case — disjoint grammar. `string-expression` shares no grammar with the
// arithmetic source, so its transfer must stay refused.
const STRING_DISJOINT = { name: 'xfam-string-disjoint', fn: 'shout', parameter: 'word',
  examples: [[' red ', 'red'], [' blue ', 'blue'], ['', '']], checks: [[' RED ', 'red'], [' BLUE ', 'blue']] };
// §4 anti-case — failed transfer. The remembered procedure is `p % 2`, but the
// target's real test wants `abs(p)`; the transfer must roll back and write nothing.
const COND_FAILING = { name: 'xfam-cond-fail', fn: 'repair', parameter: 'value',
  examples: [0, 6, 10], checks: [[-4, 4], [7, 7]] };

const ARITH_QUALIFY = { drift: 'qualify/drift.md', ambiguous: 'qualify/ambiguous.md' };

test('preregistered cross-family cohort: a procedure transfers into a second family under the target test', t => {
  const wrongWrites = createWrongWriteCounter();
  const assertChangedPaths = wrongWrites.assertChangedPaths;
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-xfam-cohort-')));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));

  const seed = root => {
    fs.mkdirSync(root);
    write(root, '.gitignore', '*.json\n*.db*\n.huqan/\n');
    write(root, ARITH_QUALIFY.drift, 'no matching expression');
    write(root, ARITH_QUALIFY.ambiguous, 'm + 1\nm + 1');
    installArith(root, ARITH_TRAIN);
    execFileSync('git', ['init', '-qb', 'feat/xfam'], { cwd: root, stdio: 'pipe' });
    commit(root);
  };
  const roots = { baseline: path.join(parent, 'baseline'), learned: path.join(parent, 'learned') };
  for (const root of Object.values(roots)) seed(root);

  const markTraining = root => {
    const file = path.join(root, `${ARITH_TRAIN.name}.json`);
    const task = JSON.parse(fs.readFileSync(file, 'utf8'));
    task.qualificationPaths = [ARITH_QUALIFY.drift, ARITH_QUALIFY.ambiguous];
    task.synthesis.rememberFile = '.huqan/coder/candidates/parity.json';
    fs.writeFileSync(file, JSON.stringify(task));
  };
  markTraining(roots.learned);
  const training = run(roots.learned, ARITH_TRAIN.name, '--synthesize');
  assert.equal(training.result.data.outcome, 'applied_tested', JSON.stringify(training.result));
  assert.equal(training.result.data.synthesis.memory.ok, true);
  commit(roots.learned);
  const trainingProcesses = training.processes;
  const trainingWallMs = training.wallMs;
  const arithCandidateHash = digest(fs.readFileSync(path.join(roots.learned, '.huqan/coder/candidates/parity.json'), 'utf8'));

  const evidence = [];
  let baselineProcesses = 0, transferProcesses = 0, baselineWallMs = 0, transferWallMs = 0;
  for (const item of COND_HOLDOUT) {
    const baselineFixture = installConditional(roots.baseline, item);
    const transferFixture = installConditional(roots.learned, item);
    assert.equal(baselineFixture.taskHash, transferFixture.taskHash);
    assert.equal(baselineFixture.testHash, transferFixture.testHash);
    assert.equal(baselineFixture.content, transferFixture.content);
    for (const root of Object.values(roots)) commit(root);
    // Baseline: the target family's own search cannot reach a plain branch, so it
    // exhausts its budget and writes nothing.
    const baseline = run(roots.baseline, item.name, '--synthesize', { expectedStatus: 6 });
    assert.equal(baseline.result.data.outcome, 'needs_human_decision', JSON.stringify(baseline.result));
    assert.equal(baseline.result.data.reason, 'ALL_CANDIDATES_EXHAUSTED');
    assert.equal(baseline.processes, CONTRACT.budget);
    assert.equal(fs.readFileSync(path.join(roots.baseline, `src/${item.name}.js`), 'utf8'), baselineFixture.content);
    assertChangedPaths(baseline.changed, [], `${item.name} baseline refusal`);
    // Transfer: the remembered arithmetic procedure re-derives into the target
    // grammar and passes the target's own real test.
    const transfer = run(roots.learned, item.name, '--adapt-memory');
    assert.equal(transfer.result.data.outcome, 'applied_tested', JSON.stringify(transfer.result));
    assert.equal(transfer.result.data.record.observedVerification.ok, true);
    assert.equal(transfer.result.data.attempts[0].test.ok, true);
    assert.equal(fs.readFileSync(path.join(roots.learned, `src/${item.name}.js`), 'utf8'),
      `function ${item.fn}(${item.parameter}) { return (${item.parameter} % 2); }\nmodule.exports = ${item.fn};\n`);
    assertChangedPaths(transfer.changed, [`src/${item.name}.js`], `${item.name} transfer`);
    evidence.push({ task: item.name, taskHash: baselineFixture.taskHash, testHash: baselineFixture.testHash,
      baselineProcesses: baseline.processes, transferProcesses: transfer.processes, maxProcesses: CONTRACT.budget,
      baselineWallMs: Math.round(baseline.wallMs), transferWallMs: Math.round(transfer.wallMs),
      outcome: 'applied_tested' });
    baselineProcesses += baseline.processes; transferProcesses += transfer.processes;
    baselineWallMs += baseline.wallMs; transferWallMs += transfer.wallMs;
  }

  // §4 anti-case — disjoint grammar. A string target shares no grammar with the
  // arithmetic source, so the transfer must refuse and write nothing.
  const disjointFixture = installString(roots.learned, STRING_DISJOINT);
  commit(roots.learned);
  const disjoint = run(roots.learned, STRING_DISJOINT.name, '--adapt-memory', { expectedStatus: 6 });
  assert.equal(disjoint.result.data.reason, 'no_applicable_candidate', JSON.stringify(disjoint.result));
  assert.equal(disjoint.processes, 0);
  assert.equal(fs.readFileSync(path.join(roots.learned, `src/${STRING_DISJOINT.name}.js`), 'utf8'), disjointFixture.content);
  assertChangedPaths(disjoint.changed, [], `${STRING_DISJOINT.name} disjoint refusal`);

  // §4 anti-case — failed transfer. The procedure re-derives, but the target's own
  // test rejects it; the write must roll back and leave the source unchanged.
  const failingFixture = installConditional(roots.learned, COND_FAILING);
  commit(roots.learned);
  const failing = run(roots.learned, COND_FAILING.name, '--adapt-memory', { expectedStatus: 6 });
  assert.equal(failing.result.data.outcome, 'needs_human_decision', JSON.stringify(failing.result));
  assert.equal(failing.result.data.attempts[0].apply.reason, 'transfer_verification_failed');
  assert.equal(failing.result.data.attempts[0].test.ok, false);
  assert.equal(failing.result.data.attempts[0].rolledBack, true);
  assert.equal(failing.processes, 1);
  assert.equal(fs.readFileSync(path.join(roots.learned, `src/${COND_FAILING.name}.js`), 'utf8'), failingFixture.content);
  assertChangedPaths(failing.changed, [], `${COND_FAILING.name} rollback`);

  // §4 restart: every CLI call was already a fresh process; reopen the journal
  // store and confirm the eligibility ledger survived. The training winner is a
  // later candidate (parity is not separable from the buggy body by examples
  // alone), so the positive record is looked up by the candidate's own run id.
  const candidate = JSON.parse(fs.readFileSync(path.join(roots.learned, '.huqan/coder/candidates/parity.json'), 'utf8'));
  const store = openCoderJournal(path.join(roots.learned, 'journal.db'));
  try {
    assert.equal(store.journal.manifest(candidate.runId).learningEligibility, 'positive_procedure');
    for (const item of COND_HOLDOUT)
      assert.equal(store.journal.manifest(`${item.name}:c1`).learningEligibility, 'positive_procedure');
    assert.equal(store.journal.manifest(`${COND_FAILING.name}:c1`).learningEligibility, 'negative_example');
  } finally { store.close(); }
  assert.equal(digest(fs.readFileSync(path.join(roots.learned, '.huqan/coder/candidates/parity.json'), 'utf8')), arithCandidateHash);

  const perTaskProcessGain = evidence.filter(row => row.transferProcesses < row.baselineProcesses).length;
  const holdoutCountMet = COND_HOLDOUT.length >= CONTRACT.holdoutPerFamily;
  const amortizedSavedProcesses = baselineProcesses - transferProcesses - trainingProcesses;
  // Every preregistered gate is a hard assert above, so reaching the report means
  // accuracy (H1a), per-task process gain (H1b) and both anti-cases held. The
  // report classifies the measurement; the test run's exit status only says the
  // measurement is valid.
  const hypothesisVerdict = holdoutCountMet && perTaskProcessGain === evidence.length
    && wrongWrites.count === 0 ? 'GAIN' : 'INSUFFICIENT';
  const report = {
    preregistration: CONTRACT.preregistration,
    scope: 'two-family (arithmetic/parity source + conditional/parity target) cross-family transfer eval',
    contract: CONTRACT,
    training: { processes: trainingProcesses, wallMs: Math.round(trainingWallMs) },
    holdoutEvidence: evidence, holdoutSize: evidence.length,
    totals: { baselineProcesses, transferProcesses,
      amortizedSavedProcesses, baselineHoldoutWallMs: Math.round(baselineWallMs),
      transferHoldoutWallMs: Math.round(transferWallMs), trainingWallMs: Math.round(trainingWallMs),
      cpuCost: 'NOT_MEASURED (no cross-platform child-CPU sampling without new dependencies)' },
    disjointGrammarControl: { task: STRING_DISJOINT.name, reason: disjoint.result.data.reason,
      sourceUnchanged: true, writes: 0 },
    failedTransferControl: { task: COND_FAILING.name, outcome: failing.result.data.outcome,
      reason: failing.result.data.attempts[0].apply.reason, rolledBack: true, sourceUnchanged: true },
    restartPersistence: { journalReopened: true, manifestSurvived: true, candidateUnchanged: true },
    metricVerdicts: {
      accuracy: 'MEASURED',
      wrongWrites: wrongWrites.count === 0 && CONTRACT.wrongWriteTolerance === 0 ? 'REJECT_THRESHOLD_UNTRIGGERED' : 'REJECT',
      holdoutCount: holdoutCountMet ? 'MEASURED' : 'INSUFFICIENT',
      perTaskProcessGain: `${perTaskProcessGain}/${evidence.length}`,
      cpuCost: 'NOT_MEASURED',
    },
    verdict: { testRun: 'PASSED', status: hypothesisVerdict },
  };
  // The preregistered H1 verdict must be the report's actual value; this pins the
  // expected outcome for this measurement so a silent change in the verdict fails.
  assert.equal(report.verdict.status, 'GAIN');
  t.diagnostic(JSON.stringify(report));
});

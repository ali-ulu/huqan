'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const yaml = require('js-yaml');

const scriptPath = path.join(__dirname, '..', 'scripts', 'coverage-gate-history.js');
const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'benchmark.yml');
const { decide } = require(scriptPath);

// Issue #3970: a measured coverage failure on one main commit must not be
// hidden by later commits that skip coverage as NOT_APPLICABLE. The green
// skip means "nothing was measured here", never "the alarm is gone", so the
// newest completed measured verdict decides the alarm state until a later
// successful measurement supersedes it.

function run(overrides) {
  return {
    head_sha: 'a'.repeat(40),
    event: 'push',
    status: 'completed',
    run_number: 1,
    run_attempt: 1,
    html_url: 'https://github.com/ali-ulu/huqan/actions/runs/1',
    coverage: null,
    ...overrides,
  };
}

test('a failed measured result stays unresolved across later NOT_APPLICABLE skips', () => {
  const runs = [
    // The false-green window from #3970: the newest commit only skipped, so
    // the old failure must still decide the alarm.
    run({ run_number: 389, head_sha: 'c'.repeat(40), coverage: null }),
    run({ run_number: 388, head_sha: 'b'.repeat(40), coverage: null }),
    run({ run_number: 387, head_sha: 'a'.repeat(40), coverage: 'failure' }),
  ];
  const decision = decide(runs);
  assert.equal(decision.verdict, 'unresolved');
  assert.equal(decision.measured.run_number, 387);
  assert.equal(decision.measured.coverage, 'failure');
  assert.match(decision.reason, /failure/);
});

test('only a later successful measured result clears the alarm', () => {
  const runs = [
    run({ run_number: 390, coverage: null }),
    run({ run_number: 389, coverage: 'success' }),
    run({ run_number: 388, coverage: 'failure' }),
  ];
  const decision = decide(runs);
  assert.equal(decision.verdict, 'clear');
  assert.equal(decision.measured.run_number, 389);
});

test('a history of skip-only runs carries no alarm', () => {
  assert.equal(decide([run({ run_number: 2, coverage: null }), run({ run_number: 1, coverage: null })]).verdict, 'none');
  assert.equal(decide([]).verdict, 'none');
  assert.equal(decide(undefined).verdict, 'none');
});

test('a measurement still in flight neither raises nor clears an alarm', () => {
  const runs = [
    run({ run_number: 391, status: 'in_progress', coverage: null }),
    run({ run_number: 390, coverage: 'failure' }),
  ];
  assert.equal(decide(runs).verdict, 'unresolved');
});

test('a pull request run is never a verdict about main', () => {
  const runs = [
    run({ run_number: 391, event: 'pull_request', coverage: 'failure' }),
    run({ run_number: 390, coverage: 'success' }),
  ];
  assert.equal(decide(runs).verdict, 'clear');
});

test('non-success measured verdicts fail closed', () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'startup_failure']) {
    const decision = decide([run({ run_number: 2, coverage: null }), run({ run_number: 1, coverage: conclusion })]);
    assert.equal(decision.verdict, 'unresolved', conclusion);
  }
});

test('a skipped Coverage job inside a run is transparent, not a measurement', () => {
  const runs = [run({ run_number: 2, coverage: 'skipped' }), run({ run_number: 1, coverage: 'failure' })];
  assert.equal(decide(runs).verdict, 'unresolved');
});

test('the workflow run number, not the list order, decides which verdict is newest', () => {
  const runs = [
    run({ run_number: 100, coverage: 'failure' }),
    run({ run_number: 101, coverage: 'success' }),
  ];
  assert.equal(decide(runs).verdict, 'clear');
});

test('the newest attempt of a re-run supersedes the older attempt', () => {
  const runs = [
    run({ run_number: 55, run_attempt: 2, coverage: 'success' }),
    run({ run_number: 55, run_attempt: 1, coverage: 'failure' }),
  ];
  assert.equal(decide(runs).verdict, 'clear');
});

let runsFixtureCounter = 0;

function writeRuns(runs) {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-coverage-alarm-')),
    `runs-${++runsFixtureCounter}.json`,
  );
  fs.writeFileSync(file, JSON.stringify(runs));
  return file;
}

function runScript(args, env = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}

test('the CLI refuses an unresolved alarm and accepts a clear one', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-coverage-alarm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const unresolved = runScript([`--runs=${writeRuns([
    run({ run_number: 2, coverage: null }),
    run({ run_number: 1, coverage: 'failure' }),
  ])}`]);
  assert.equal(unresolved.status, 1, unresolved.stderr);
  assert.equal(JSON.parse(unresolved.stdout).verdict, 'unresolved');
  assert.match(unresolved.stderr, /::error::Coverage alarm unresolved/);

  const clear = runScript([`--runs=${writeRuns([run({ run_number: 2, coverage: 'success' })])}`]);
  assert.equal(clear.status, 0, clear.stderr);
  assert.equal(JSON.parse(clear.stdout).verdict, 'clear');

  const missing = runScript([]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /missing required --runs/);

  const unknownOption = runScript(['--history=x']);
  assert.equal(unknownOption.status, 2);

  const notJson = path.join(dir, 'not-json.json');
  fs.writeFileSync(notJson, '{oops');
  const unreadable = runScript([`--runs=${notJson}`]);
  assert.equal(unreadable.status, 2);
  assert.match(unreadable.stderr, /could not read the runs history/);

  const notArray = path.join(dir, 'not-array.json');
  fs.writeFileSync(notArray, '{"runs":[]}');
  const wrongShape = runScript([`--runs=${notArray}`]);
  assert.equal(wrongShape.status, 2);
  assert.match(wrongShape.stderr, /must be a JSON array/);
});

// The gate wiring itself: the skip path of a non-pull-request run must consult
// the history, and the job needs read-only run access to do it.

const workflow = yaml.load(fs.readFileSync(workflowPath, 'utf8'));
// js-yaml's YAML 1.1 schema parses the unquoted `on` key as the boolean
// `true`; both forms name the trigger map.
const triggers = workflow.on || workflow.true;

test('the coverage gate refuses to clear an unresolved alarm after a merge', () => {
  const gate = workflow.jobs['coverage-gate'];
  assert.ok(gate, 'coverage-gate job must exist');
  assert.deepEqual(gate.permissions, { actions: 'read', contents: 'read' });

  const alarmStep = gate.steps.find((step) => step.name === 'Refuse to clear an unresolved coverage alarm');
  assert.ok(alarmStep, 'the unresolved-alarm step must exist');
  assert.match(String(alarmStep.if), /github\.event_name != 'pull_request'/);
  assert.match(String(alarmStep.if), /needs\.classify\.outputs\.source_only != 'yes'/);
  assert.match(alarmStep.run, /scripts[\\/]coverage-gate-history\.js/);
  // The workflow-scoped endpoint is pinned because the repo-level runs list
  // silently ignores an unknown branch parameter and would feed the walk a
  // page of unrelated runs.
  assert.match(alarmStep.run, /actions\/workflows\/benchmark\.yml\/runs\?branch=main/);
  assert.match(alarmStep.run, /event != "pull_request"/);
  assert.match(String(alarmStep.env && alarmStep.env.GH_TOKEN), /github\.token/);
  // The walk stops at the first measured verdict, so the alarm cannot expire
  // behind a streak of NOT_APPLICABLE commits (#3970 review finding).
  assert.match(alarmStep.run, /per_page=100/);
  assert.match(alarmStep.run, /\.\[:100\]\[\]/);
  assert.match(alarmStep.run, /\[ "\$\{conclusion\}" != "skipped" \]/);
  assert.match(alarmStep.run, /^\s*break\s*$/m);
});

test('the alarm checkout stays pinned and credential-free', () => {
  const gate = workflow.jobs['coverage-gate'];
  const alarmStep = gate.steps.find((step) => step.name === 'Refuse to clear an unresolved coverage alarm');
  const alarmIndex = gate.steps.indexOf(alarmStep);
  const checkout = gate.steps[alarmIndex - 1];
  assert.equal(checkout.uses, 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1');
  assert.equal(checkout.with['persist-credentials'], false);
  assert.match(String(checkout.with['sparse-checkout']), /scripts\/coverage-gate-history\.js/);
  assert.equal(checkout.if, alarmStep.if, 'the checkout must be as conditional as the step it feeds');
});

test('the operator can demand a real measurement through a dispatch input', () => {
  const dispatch = triggers && triggers['workflow_dispatch'];
  assert.ok(dispatch && typeof dispatch === 'object', 'workflow_dispatch must declare inputs');
  const inputs = dispatch.inputs || {};
  assert.ok(inputs.force_coverage, 'workflow_dispatch must declare a force_coverage input');
  assert.equal(inputs.force_coverage.type, 'boolean');

  const classifyStep = workflow.jobs.classify.steps.find((step) => step.id === 'classify');
  assert.ok(classifyStep, 'the classify step must exist');
  assert.match(classifyStep.run, /force_coverage/);
  assert.match(classifyStep.run, /GITHUB_EVENT_NAME.*workflow_dispatch/);
});

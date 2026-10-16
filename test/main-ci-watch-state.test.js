'use strict';

// Main CI Watch (#3662, #3663): main is green only when every post-merge
// required check was observed and passed, and the watcher runs when main's
// workflows complete instead of trusting the schedule alone.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');

const { VERDICTS, mainCiState, main } = require('../scripts/main-ci-watch-state');

const REPO_ROOT = path.resolve(__dirname, '..');
const INVENTORY_PATH = path.join(REPO_ROOT, '.github', 'main-ci-watch-contexts.json');
const WATCH_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'main-ci-watch.yml');
const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, 'utf8'));

const COMMITTED = '2026-10-08T12:00:00Z';
const SETTLED_NOW = '2026-10-08T12:10:00Z';
const GATES = Object.keys(inventory.postMerge);
const WORKFLOWS_OK = [
  { name: 'API Contract', status: 'completed', conclusion: 'success', run_number: 1, run_attempt: 1 },
  { name: 'Benchmark Regression', status: 'completed', conclusion: 'success', run_number: 1, run_attempt: 1 },
];

function readWorkflow(file) {
  return yaml.load(fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', file), 'utf8'));
}

// js-yaml reads the bare `on:` key as boolean true.
function triggersOf(workflow) {
  const on = workflow.on ?? workflow[true];
  if (typeof on === 'string') return [on];
  return Array.isArray(on) ? on : Object.keys(on || {});
}

function jobNames(workflow) {
  return Object.values(workflow.jobs || {}).map((job) => job && job.name).filter(Boolean);
}

function checkRun(id, name, conclusion = 'success', status = 'completed') {
  return { id, name, status, conclusion };
}

function greenCheckRuns() {
  return GATES.map((name, index) => checkRun(index + 1, name));
}

function state(overrides = {}) {
  return mainCiState({
    inventory,
    checkRuns: greenCheckRuns(),
    workflowRuns: WORKFLOWS_OK,
    committedAt: COMMITTED,
    now: SETTLED_NOW,
    ...overrides,
  });
}

test('the inventory classifies every ruleset check exactly once', () => {
  const ruleset = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.github', 'rulesets', 'main-branch.json'), 'utf8'));
  const required = ruleset.rules
    .find((rule) => rule.type === 'required_status_checks')
    .parameters.required_status_checks.map((check) => check.context);
  const classified = [...Object.keys(inventory.postMerge), ...Object.keys(inventory.prOnly)];
  assert.equal(new Set(classified).size, classified.length, 'a context is classified twice');
  assert.deepEqual([...classified].sort(), [...required].sort());
});

test('a post-merge context comes from a workflow that runs on push, a PR-only one from a workflow that does not', () => {
  for (const [group, expectPush] of [['postMerge', true], ['prOnly', false]]) {
    for (const [context, file] of Object.entries(inventory[group])) {
      const workflow = readWorkflow(file);
      assert.ok(jobNames(workflow).includes(context), `${file} has no job named "${context}"`);
      assert.equal(triggersOf(workflow).includes('push'), expectPush,
        `${context} (${file}) is ${group} but the workflow ${expectPush ? 'has no' : 'has a'} push trigger; reclassify it`);
    }
  }
});

test('#3662: only two workflows and no gate check runs is missing evidence, not green', () => {
  const verdict = state({ checkRuns: [checkRun(1, 'API Contract'), checkRun(2, 'Classify changes')] });
  assert.equal(verdict.verdict, VERDICTS.MISSING);
  assert.equal(verdict.mainGreen, false);
  assert.deepEqual(verdict.missing, GATES);
  assert.deepEqual(verdict.notObservablePostMerge, Object.keys(inventory.prOnly));
});

test('one missing gate is enough to withhold green', () => {
  const verdict = state({ checkRuns: greenCheckRuns().slice(1) });
  assert.equal(verdict.verdict, VERDICTS.MISSING);
  assert.deepEqual(verdict.missing, [GATES[0]]);
});

test('every post-merge gate observed and passing is green', () => {
  const verdict = state();
  assert.equal(verdict.verdict, VERDICTS.GREEN);
  assert.equal(verdict.mainGreen, true);
  assert.ok(verdict.contexts.every((item) => item.state === 'SUCCESS'));
});

test('skipped and neutral conclusions pass', () => {
  const runs = greenCheckRuns();
  runs[0].conclusion = 'skipped';
  runs[1].conclusion = 'neutral';
  assert.equal(state({ checkRuns: runs }).verdict, VERDICTS.GREEN);
});

test('a failed gate is reported as failed, ahead of a missing one', () => {
  const runs = greenCheckRuns().slice(1);
  runs[0].conclusion = 'failure';
  const verdict = state({ checkRuns: runs });
  assert.equal(verdict.verdict, VERDICTS.FAILED);
  assert.deepEqual(verdict.failed, [GATES[1]]);
  assert.deepEqual(verdict.missing, [GATES[0]]);
});

test('a gate still running is pending', () => {
  const runs = greenCheckRuns();
  runs[2] = checkRun(3, GATES[2], null, 'in_progress');
  const verdict = state({ checkRuns: runs });
  assert.equal(verdict.verdict, VERDICTS.PENDING);
  assert.deepEqual(verdict.pending, [GATES[2]]);
});

test('a rerun that passed supersedes the failed attempt, and a later failure supersedes a pass', () => {
  const rerunPassed = [...greenCheckRuns(), checkRun(0, GATES[0], 'failure')];
  assert.equal(state({ checkRuns: rerunPassed }).verdict, VERDICTS.GREEN);

  const rerunFailed = [...greenCheckRuns(), checkRun(99, GATES[0], 'failure')];
  assert.equal(state({ checkRuns: rerunFailed }).verdict, VERDICTS.FAILED);
});

test('an unsettled commit and a commit with no workflow runs are never green', () => {
  assert.equal(state({ now: '2026-10-08T12:04:59Z' }).verdict, VERDICTS.NOT_SETTLED);
  assert.equal(state({ workflowRuns: [] }).verdict, VERDICTS.NO_WORKFLOW_RUNS);
});

test('a failing latest workflow attempt blocks green even when every gate passed', () => {
  const workflows = [
    ...WORKFLOWS_OK,
    { name: 'Publish to npm', status: 'completed', conclusion: 'success', run_number: 4, run_attempt: 1 },
    { name: 'Publish to npm', status: 'completed', conclusion: 'failure', run_number: 4, run_attempt: 2 },
    { name: 'Main CI Watch', status: 'in_progress', conclusion: null, run_number: 9, run_attempt: 1 },
  ];
  const verdict = state({ workflowRuns: workflows });
  assert.equal(verdict.verdict, VERDICTS.WORKFLOW_BLOCKING);
  assert.deepEqual(verdict.blockingWorkflows, ['Publish to npm']);
});

test('a malformed inventory or timestamp is refused', () => {
  assert.throws(() => state({ inventory: { postMerge: {}, prOnly: {} } }), /at least one context/);
  assert.throws(() => state({ inventory: { postMerge: { a: 'x.yml' } } }), /prOnly/);
  assert.throws(() => state({ committedAt: 'yesterday' }), /committedAt/);
});

test('the CLI reads the three files and prints the verdict', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-main-ci-watch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const checks = path.join(dir, 'checks.json');
  const workflows = path.join(dir, 'workflows.json');
  fs.writeFileSync(checks, JSON.stringify(greenCheckRuns().slice(1)));
  fs.writeFileSync(workflows, JSON.stringify(WORKFLOWS_OK));
  const out = [];
  t.mock.method(process.stdout, 'write', (chunk) => { out.push(String(chunk)); return true; });
  const code = main(['--inventory', INVENTORY_PATH, '--check-runs', checks, '--workflow-runs', workflows,
    '--committed-at', COMMITTED, '--now', SETTLED_NOW]);
  t.mock.restoreAll();
  assert.equal(code, 0);
  const printed = JSON.parse(out.join(''));
  assert.equal(printed.verdict, VERDICTS.MISSING);
  assert.equal(printed.mainGreen, false);
  assert.throws(() => main(['--check-runs', checks]), /--inventory is required/);
});

test('#3663: the watcher runs when each workflow that runs on main completes, not on the schedule alone', () => {
  const watch = yaml.load(fs.readFileSync(WATCH_PATH, 'utf8'));
  const on = watch.on ?? watch[true];
  assert.deepEqual(on.workflow_run.types, ['completed']);
  assert.equal(on.workflow_run.branches, undefined, 'a branch filter hides the tag-triggered Publish run (#3331)');
  assert.ok(on.schedule, 'the schedule stays as the fallback');

  const pushWorkflows = fs.readdirSync(path.join(REPO_ROOT, '.github', 'workflows'))
    .filter((file) => file.endsWith('.yml'))
    .map(readWorkflow)
    .filter((workflow) => triggersOf(workflow).includes('push'))
    .map((workflow) => workflow.name);
  assert.ok(pushWorkflows.length > 0);
  for (const name of pushWorkflows) {
    assert.ok(on.workflow_run.workflows.includes(name), `Main CI Watch does not wake when "${name}" completes`);
  }

  const job = watch.jobs['inspect-main'];
  assert.match(job.if, /workflow_run\.event != 'pull_request'/, 'a pull request run says nothing about main');
  assert.equal(watch.concurrency['cancel-in-progress'], false, 'an event-triggered run must not cancel one mid-alert');
  const run = job.steps.map((step) => step.run || '').join('\n');
  assert.match(run, /node scripts\/main-ci-watch-state\.js/);
  assert.match(run, /check-runs\?per_page=100/);
});

test('the watcher checks out what the verdict needs and only withholds green when the verdict fails', () => {
  const watch = yaml.load(fs.readFileSync(WATCH_PATH, 'utf8'));
  const steps = watch.jobs['inspect-main'].steps;
  const checkout = steps.find((step) => String(step.uses || '').startsWith('actions/checkout@'));
  assert.ok(checkout, 'the script and inventory need a checkout');
  const sparse = String(checkout.with['sparse-checkout']).split('\n').map((line) => line.trim()).filter(Boolean);
  for (const file of ['.github/main-ci-watch-contexts.json', 'scripts/main-ci-watch-state.js']) {
    assert.ok(sparse.includes(file), `sparse checkout is missing ${file}`);
    assert.ok(fs.existsSync(path.join(REPO_ROOT, file)), `${file} does not exist`);
  }

  const run = steps.map((step) => step.run || '').join('\n');
  const alertLoop = run.indexOf('for sha in "${shas[@]}"; do');
  const verdictCall = run.indexOf('node scripts/main-ci-watch-state.js');
  const closeGate = run.indexOf('if [[ "$main_green" == "true" ]]; then');
  assert.ok(alertLoop >= 0 && verdictCall > alertLoop, 'the verdict runs after the alert loop, so its failure cannot stop alerts');
  assert.ok(closeGate > verdictCall, 'alert issues close only behind the main_green gate');
  assert.match(run, /main_green=false\n/, 'main is not green until the verdict says so');
  assert.match(run, /::warning::Could not compute the main CI state/);
  assert.match(run, /sleep \$\(\( 300 - age \)\)/, 'an event-triggered run waits for the commit to settle');
  assert.ok(watch.jobs['inspect-main']['timeout-minutes'] >= 15, 'the job outlives the settle wait');
});

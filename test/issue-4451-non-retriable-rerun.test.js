'use strict';

/**
 * #4451: Main CI Watch must keep scanning when a failed run cannot be
 * re-run.
 *
 * A Dependabot `dynamic` run fails; the watcher called
 * `POST .../rerun-failed-jobs`, GitHub answered HTTP 403 "This workflow run
 * cannot be retried", and `gh api` exited non-zero. Under `set -euo pipefail`
 * that killed the whole step: the scan stopped, later commits were never
 * inspected and alert handling never ran.
 *
 * The watcher now classifies a dynamic run as non-retriable before it retries,
 * tolerates a refused retry the same way, records the run id, its event and the
 * reason, and keeps going. This test executes the workflow's own shell against
 * a `gh` shim, like test/issue-4128-tag-run-window.test.js, so the behaviour is
 * checked by execution rather than by asserting on the YAML text.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');

const REPO_ROOT = path.resolve(__dirname, '..');
const WATCH_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'main-ci-watch.yml');

const MARKER = 'Created automatically by the repository-native Main CI Watch workflow';

/** The workflow shell needs bash >= 4 (mapfile), jq and sed; skip otherwise. */
function findBash() {
  const candidates = [
    process.env.BASH_FOR_TESTS,
    '/opt/homebrew/bin/bash',
    '/usr/local/bin/bash',
    'bash',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'printf %s "$BASH_VERSINFO"'], { encoding: 'utf8' });
    if (probe.status === 0 && Number(probe.stdout) >= 4) return candidate;
  }
  return null;
}

const BASH = findBash();
const SKIP = (() => {
  if (!BASH) return 'the workflow shell needs bash >= 4 (mapfile); only /bin/bash 3.2 found';
  const has = (command) => spawnSync(BASH, ['-c', `command -v ${command} >/dev/null 2>&1`]).status === 0;
  if (!has('jq')) return 'the workflow shell needs jq';
  if (!has('sed')) return 'the workflow shell needs sed';
  return false;
})();

/** The `run:` block of the alert step, with /tmp redirected into the fixture. */
function alertScript() {
  const workflow = yaml.load(fs.readFileSync(WATCH_PATH, 'utf8'));
  const step = workflow.jobs['inspect-main'].steps
    .find((candidate) => String(candidate.name).startsWith('Re-run transient'));
  assert.ok(step, 'the alert step must exist');
  return step.run.replaceAll('/tmp/', '"${TEST_DIR}"/');
}

const sha = (prefix) => prefix.padEnd(40, '0');
const MAIN_SHAS = Array.from({ length: 10 }, (unused, index) => sha(`aa${String(index + 1).padStart(2, '0')}`));
const GREEN_CHECKS = [
  { id: 1, name: 'npm test gate', status: 'completed', conclusion: 'success' },
  { id: 2, name: 'Benchmark gate', status: 'completed', conclusion: 'success' },
  { id: 3, name: 'Docker build gate', status: 'completed', conclusion: 'success' },
  { id: 4, name: 'Coverage gate', status: 'completed', conclusion: 'success' },
];
const OLD = '2020-01-01T00:00:00Z';

const DEPENDABOT_RUN = {
  id: 41240906206,
  name: 'npm_and_yarn in /. for minimatch - Update #1668558748',
  event: 'dynamic',
  status: 'completed',
  conclusion: 'failure',
  run_number: 39,
  run_attempt: 1,
  html_url: 'https://example.invalid/41240906206',
};
const BENCHMARK_RUN = {
  id: 700,
  name: 'Benchmark Regression',
  event: 'push',
  status: 'completed',
  conclusion: 'failure',
  run_number: 7953,
  run_attempt: 1,
  html_url: 'https://example.invalid/700',
};
// A push failure on a later attempt is not eligible for the automatic re-run,
// so it is a persistent failure the watcher must alert on.
const PERSISTENT_RUN = { ...BENCHMARK_RUN, id: 701, run_number: 7954, run_attempt: 2, html_url: 'https://example.invalid/701' };

/**
 * A `gh` shim plus the workflow's own shell. The shim answers from files under
 * `$TEST_DIR` and records retry attempts, issue creations and closures, so the
 * assertions are about what the watcher *did*.
 *
 * `rerun-failed-jobs` answers with the recorded status: 403 for a run listed in
 * `data/refuse-rerun.json`, success otherwise. It prints a JSON body and exits
 * non-zero exactly like `gh api` does.
 */
function ghShim() {
  return String.raw`
gh() {
  local args=("$@") filter="" url="" raw="" i method="" is_rerun=false
  for ((i=0; i<${'${#args[@]}'}; i++)); do
    case "${'${args[i]}'}" in
      --jq) filter="${'${args[i+1]}'}";;
      --method) method="${'${args[i+1]}'}";;
    esac
    [[ "${'${args[i]}'}" == *"rerun-failed-jobs" ]] && is_rerun=true
    case "${'${args[i]}'}" in repos/*) url="${'${args[i]}'}" ;;& esac
  done
  local data="$TEST_DIR/data"

  if [[ "$is_rerun" == true ]]; then
    local run_id="$(sed -E 's#.*/actions/runs/([0-9]+)/rerun-failed-jobs.*#\1#' <<<"$url")"
    printf '%s\n' "$run_id" >> "$TEST_DIR/retried.log"
    if jq -e --argjson id "$run_id" 'index($id) != null' "$data/refuse-rerun.json" >/dev/null; then
      printf '{"message":"This workflow run cannot be retried","documentation_url":"https://docs.github.com/rest/actions/workflow-runs#re-run-failed-jobs-from-a-workflow-run","status":"403"}\n'
      printf 'gh: This workflow run cannot be retried (HTTP 403)\n' >&2
      return 1
    fi
    printf '{"status":"ok"}\n'
    return 0
  fi

  if [[ "${'${args[0]}'}" == "issue" ]]; then
    local state="open" sub="${'${args[1]}'}" j
    for ((j=0; j<${'${#args[@]}'}; j++)); do
      [[ "${'${args[j]}'}" == "--state" ]] && state="${'${args[j+1]}'}"
    done
    case "$sub" in
      list) if [[ -n "$filter" ]]; then jq -r "$filter" "$data/issues-$state.json"; else cat "$data/issues-$state.json"; fi; return 0;;
      create)
        local title="" body="" bodyfile="" k
        for ((k=0; k<${'${#args[@]}'}; k++)); do
          [[ "${'${args[k]}'}" == "--title" ]] && title="${'${args[k+1]}'}"
          [[ "${'${args[k]}'}" == "--body-file" ]] && bodyfile="${'${args[k+1]}'}"
        done
        [[ -n "$bodyfile" ]] && body="$(cat "$bodyfile")"
        printf '%s\n' "$title" >> "$TEST_DIR/created.log"
        jq -c --arg t "$title" --arg b "$body" \
          '. + [{"number": (length + 1000), "title": $t, "body": $b}]' \
          "$data/issues-open.json" > "$data/issues-open.tmp" && mv "$data/issues-open.tmp" "$data/issues-open.json"
        printf 'https://example.invalid/issues/created\n'
        return 0;;
      close)
        printf '%s\n' "${'${args[2]}'}" >> "$TEST_DIR/closed.log"
        jq -c --argjson n "${'${args[2]}'}" '[.[] | select(.number != $n)]' \
          "$data/issues-open.json" > "$data/issues-open.tmp" && mv "$data/issues-open.tmp" "$data/issues-open.json"
        return 0;;
      comment)
        printf '%s\n' "${'${args[2]}'}" >> "$TEST_DIR/commented.log"
        return 0;;
    esac
    return 0
  fi

  case "$url" in
    *"/actions/runs?head_sha="*) printf '%s\n' "$(sed -E 's#.*head_sha=([^&]+).*#\1#' <<<"$url")" >> "$TEST_DIR/looked-up.log";;
  esac
  case "$url" in
    *"commits?sha=main"*) raw="$data/commits-main.json";;
    *"/check-runs"*) raw="$data/checks-$(sed -E 's#.*/commits/([^/]+)/check-runs.*#\1#' <<<"$url").json";;
    *"/actions/runs/"*"/jobs"*) raw="$data/jobs.json";;
    *"/actions/runs?head_sha="*) raw="$data/runs-$(sed -E 's#.*head_sha=([^&]+).*#\1#' <<<"$url").json";;
    *"/commits/"*) raw="$data/commit-$(sed -E 's#.*/commits/([^/]+)$#\1#' <<<"$url").json";;
  esac
  if [[ -z "$raw" || ! -f "$raw" ]]; then
    printf 'gh-shim: no fixture for %s\n' "$url" >&2
    return 1
  fi
  if [[ -n "$filter" ]]; then jq -r "$filter" "$raw"; else cat "$raw"; fi
}`;
}

/**
 * Fixture: ten green main commits. `shape` decides which runs are failed.
 *  - `dependabot`: the dynamic Dependabot run fails on the newest commit; the
 *    API refuses to re-run it.
 *  - `benchmark`: a push run fails on the oldest commit and the retry succeeds.
 */
function fixtures(dir, { shape }) {
  const data = path.join(dir, 'data');
  fs.mkdirSync(data, { recursive: true });

  fs.writeFileSync(path.join(data, 'commits-main.json'),
    JSON.stringify(MAIN_SHAS.map((value) => ({ sha: value }))));

  for (const value of MAIN_SHAS) {
    fs.writeFileSync(path.join(data, `commit-${value}.json`),
      JSON.stringify({ commit: { committer: { date: OLD } } }));
    fs.writeFileSync(path.join(data, `checks-${value}.json`),
      JSON.stringify({ check_runs: GREEN_CHECKS }));
    fs.writeFileSync(path.join(data, `runs-${value}.json`), JSON.stringify({
      workflow_runs: [{ id: 1, name: 'Benchmark Regression', status: 'completed', conclusion: 'success', run_number: 1, run_attempt: 1, html_url: 'https://example.invalid/1' }],
    }));
  }

  const refuse = [];
  if (shape === 'dependabot') {
    // The newest commit carries only the non-rerunnable dynamic run; the
    // oldest carries an actionable benchmark failure the scan must still reach.
    fs.writeFileSync(path.join(data, `runs-${MAIN_SHAS[0]}.json`),
      JSON.stringify({ workflow_runs: [DEPENDABOT_RUN] }));
    fs.writeFileSync(path.join(data, `runs-${MAIN_SHAS[9]}.json`),
      JSON.stringify({ workflow_runs: [PERSISTENT_RUN] }));
    // Keep main from being called green: a non-actionable dynamic run no longer
    // withholds green (#4458), and a green main retires the alerts this test is
    // about. A failed gate is a real, non-overdue reason to withhold green.
    fs.writeFileSync(path.join(data, `checks-${MAIN_SHAS[0]}.json`), JSON.stringify({
      check_runs: GREEN_CHECKS.map((run, index) => (index === 0 ? { ...run, conclusion: 'failure' } : run)),
    }));
    refuse.push(DEPENDABOT_RUN.id);
  }
  if (shape === 'benchmark') {
    fs.writeFileSync(path.join(data, `runs-${MAIN_SHAS[0]}.json`),
      JSON.stringify({ workflow_runs: [BENCHMARK_RUN] }));
  }

  fs.writeFileSync(path.join(data, 'refuse-rerun.json'), JSON.stringify(refuse));
  fs.writeFileSync(path.join(data, 'jobs.json'), JSON.stringify({ total_count: 1 }));
  fs.writeFileSync(path.join(data, 'issues-open.json'), '[]');
  fs.writeFileSync(path.join(data, 'issues-closed.json'), '[]');
  return { data };
}

/**
 * Run the workflow's own shell against the `gh` shim and report what it did.
 *
 * `setup` may adjust the fixture before the run. Windows `jq` emits CRLF, so
 * the captured streams are stripped of `\r`: the watcher job runs on ubuntu
 * only, and a trailing carriage return inside a captured run id is a harness
 * artifact, not the behavior under test.
 */
function runScript(t, { shape, setup } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-issue-4451-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fixtures(dir, { shape });
  if (setup) setup(path.join(dir, 'data'));

  const harness = `${ghShim()}\n${alertScript()}`;
  const testDir = dir.replaceAll(path.sep, '/');
  const scriptPath = path.join(dir, 'harness.sh');
  fs.writeFileSync(scriptPath, harness);
  const result = spawnSync(BASH, ['-e', '-o', 'pipefail', scriptPath], {
    encoding: 'utf8',
    timeout: 20000,
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      TEST_DIR: testDir,
      REPO: 'ali-ulu/huqan',
      EVENT_SHA: '',
      GH_TOKEN: 'fixture-token',
      GITHUB_STEP_SUMMARY: path.join(testDir, 'summary.md'),
    },
  });
  assert.ifError(result.error);

  const read = (file) => (fs.existsSync(path.join(dir, file))
    ? fs.readFileSync(path.join(dir, file), 'utf8').replaceAll('\r', '').trim().split('\n').filter(Boolean)
    : []);
  const summaryPath = path.join(dir, 'summary.md');
  return {
    status: result.status,
    stdout: result.stdout.replaceAll('\r', ''),
    stderr: result.stderr.replaceAll('\r', ''),
    dir,
    summary: fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, 'utf8').replaceAll('\r', '') : '',
    created: read('created.log'),
    closed: read('closed.log'),
    retried: read('retried.log'),
    lookedUp: read('looked-up.log'),
  };
}

test('#4451: a refused re-run does not abort the pass; later commits are still scanned', { skip: SKIP }, (t) => {
  const result = runScript(t, { shape: 'dependabot' });

  assert.equal(result.status, 0,
    `a 403 from rerun-failed-jobs must not fail the watcher; stderr:\n${result.stderr}`);

  // The dynamic run is classified before any retry, so the watcher never asks.
  assert.ok(!result.retried.includes(String(DEPENDABOT_RUN.id)),
    'a dynamic (Dependabot) run must be classified non-retriable before the retry call');

  // The scan reached the oldest commit and alerted on its actionable failure.
  assert.ok(result.lookedUp.includes(MAIN_SHAS[9]),
    'the scan must continue to later candidates after a non-retriable run');
  // The newest commit's Dependabot run also raises an alert: the watcher
  // reports every failed run on a commit, and the alert is opened while the
  // verdict is not green for another reason (#4458). The non-retriable run is
  // reported, not silently skipped.
  assert.deepEqual(result.created, [
    `ci(main): ${MAIN_SHAS[0].slice(0, 7)} has failing workflow(s)`,
    `ci(main): ${MAIN_SHAS[9].slice(0, 7)} has failing workflow(s)`,
  ], 'both the non-retriable run and the later actionable failure must be alerted on');

  // The pass reports the run id, event and reason, without claiming a retry.
  assert.match(result.summary, /Not re-runnable runs \(1\)/);
  assert.match(result.summary, new RegExp(`\\| ${DEPENDABOT_RUN.id} \\| ${MAIN_SHAS[0].slice(0, 7)} \\| dynamic \\|`));
  assert.match(result.summary, /cannot be retried|does not allow re-running a dynamic/i);
  assert.doesNotMatch(result.stdout, new RegExp(`${DEPENDABOT_RUN.id}.*re-running failed jobs`),
    'the watcher must not claim it retried a run it classified as non-retriable');

  // The alert body carries the event and the reason for the non-retriable run.
  const open = JSON.parse(fs.readFileSync(path.join(result.dir, 'data', 'issues-open.json'), 'utf8'));
  const dependabotAlert = open.find((issue) => issue.title.includes(MAIN_SHAS[0].slice(0, 7)));
  assert.match(dependabotAlert.body, /### Not re-runnable/);
  assert.match(dependabotAlert.body, new RegExp(`run \`${DEPENDABOT_RUN.id}\` \\(event \`dynamic\`\\)`));
});

test('#4451: a retry the API refuses is recorded as non-retriable, not as a success', { skip: SKIP }, (t) => {
  // The benchmark retry itself is refused, so the 403 arrives at the retry call
  // rather than from the pre-classification.
  const result = runScript(t, {
    shape: 'benchmark',
    setup: (data) => fs.writeFileSync(path.join(data, 'refuse-rerun.json'), JSON.stringify([BENCHMARK_RUN.id])),
  });

  assert.equal(result.status, 0, `a refused retry must not fail the watcher; stderr:\n${result.stderr}`);
  assert.doesNotMatch(result.stderr, /no fixture/, 'the shim must answer every request');
  assert.match(result.stdout, new RegExp(`${BENCHMARK_RUN.id} is not re-runnable: This workflow run cannot be retried`));
  assert.match(result.summary, /Not re-runnable runs \(1\)/);
  assert.match(result.summary, new RegExp(`\\| ${BENCHMARK_RUN.id} \\| ${MAIN_SHAS[0].slice(0, 7)} \\| push \\|`));
  // A refused retry is a persistent failure, so it still raises the alert.
  assert.deepEqual(result.created, [`ci(main): ${MAIN_SHAS[0].slice(0, 7)} has failing workflow(s)`]);
});

test('#4451: a successful retry still holds the alert back and is not reported as non-retriable', { skip: SKIP }, (t) => {
  const result = runScript(t, { shape: 'benchmark' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.retried, [String(BENCHMARK_RUN.id)], 'the eligible failure is retried once');
  assert.deepEqual(result.created, [], 'a re-run in flight must not raise an alert yet');
  assert.doesNotMatch(result.summary, /Not re-runnable runs/);
});

test('#4451: the alert stays idempotent when a non-retriable run is the only failure', { skip: SKIP }, (t) => {
  const result = runScript(t, {
    shape: 'dependabot',
    setup: (data) => {
      // Only the dynamic failure on the newest commit; the oldest is green.
      fs.writeFileSync(path.join(data, `runs-${MAIN_SHAS[9]}.json`), JSON.stringify({
        workflow_runs: [{ id: 1, name: 'Benchmark Regression', status: 'completed', conclusion: 'success', run_number: 1, run_attempt: 1, html_url: 'https://example.invalid/1' }],
      }));
      // An open alert for that commit already exists.
      fs.writeFileSync(path.join(data, 'issues-open.json'), JSON.stringify([
        { number: 1000, title: `ci(main): ${MAIN_SHAS[0].slice(0, 7)} has failing workflow(s)`,
          body: `Main commit \`${MAIN_SHAS[0]}\` has completed workflow failures.\n\n_${MARKER}._` },
      ]));
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.created, [], 'the existing alert must not be duplicated');
  assert.match(result.stdout, /alert issue #1000 already exists/);
  const open = JSON.parse(fs.readFileSync(path.join(result.dir, 'data', 'issues-open.json'), 'utf8'));
  assert.equal(open.length, 1, 'the pass leaves exactly the one pre-existing alert');
});

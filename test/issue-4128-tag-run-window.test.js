'use strict';

/**
 * #4128: Main CI Watch must inspect the run that woke it, not only the latest
 * ten main commits, and it must not let a green main close an alert that
 * belongs to a commit outside that window.
 *
 * A tag-triggered `Publish to npm` run carries the tag as its branch, so its
 * `head_sha` can sit far behind main (`v1.1.1`'s commit is 33 behind). The
 * watcher subscribes to that workflow (#3331) but used to build its candidate
 * list only from `commits?sha=main&per_page=10`, so a re-run or retry of a
 * publish for an older tag could fail without ever being examined.
 *
 * Rather than assert on the YAML text, this runs the workflow's actual shell
 * against a `gh` shim and a fixture repository, so both halves are checked by
 * execution: the event SHA is alerted on when it is outside the window, and the
 * main-green close path leaves that alert alone while still closing an alert
 * for a commit inside the window.
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

/** The alert body marker the close path keys on. */
const MARKER = 'Created automatically by the repository-native Main CI Watch workflow';

/**
 * The workflow runs on ubuntu-latest (bash 5) and uses `mapfile` plus `jq` and
 * `sed`, so a harness that executes its shell needs bash >= 4 with those tools.
 * macOS ships 3.2 at /bin/bash, so look for a newer one before giving up; the
 * test skips rather than fails where the harness's tools are unavailable.
 */
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

function has(command) {
  const probe = spawnSync(BASH, ['-c', `command -v ${command} >/dev/null 2>&1`], { encoding: 'utf8' });
  return probe.status === 0;
}

const BASH = findBash();
const SKIP = (() => {
  if (!BASH) return 'the workflow shell needs bash >= 4 (mapfile); only /bin/bash 3.2 found';
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
  // Keep every write inside the fixture. The replacement is a quoted variable
  // expansion, not a literal path, so a Windows temp directory (backslashes,
  // possible spaces) cannot be mangled by the shell or the filesystem.
  return step.run.replaceAll('/tmp/', '"${TEST_DIR}"/');
}

const sha = (prefix) => prefix.padEnd(40, '0');
const MAIN_SHAS = Array.from({ length: 10 }, (unused, index) => sha(`aa${String(index + 1).padStart(2, '0')}`));
const TAG_SHA = sha('bb01');
const GREEN_CHECKS = [
  { id: 1, name: 'npm test gate', status: 'completed', conclusion: 'success' },
  { id: 2, name: 'Benchmark gate', status: 'completed', conclusion: 'success' },
  { id: 3, name: 'Docker build gate', status: 'completed', conclusion: 'success' },
  { id: 4, name: 'Coverage gate', status: 'completed', conclusion: 'success' },
];

const OLD = '2020-01-01T00:00:00Z';

/**
 * A `gh` shim plus the workflow's own shell. The shim answers from files under
 * `$TEST_DIR` and records issue creations and closures, so the assertions are
 * about what the watcher *did*, not about the text of the workflow.
 */
function ghShim() {
  return String.raw`
gh() {
  local args=("$@") filter="" paginate=false url="" raw="" i
  for ((i=0; i<${'${#args[@]}'}; i++)); do
    case "${'${args[i]}'}" in
      --jq) filter="${'${args[i+1]}'}";;
      --paginate) paginate=true;;
    esac
  done
  local data="$TEST_DIR/data"

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

  for i in "${'${args[@]}'}"; do
    case "$i" in repos/*) url="$i";; esac
  done
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

/** Fixture repository: ten green main commits, one red tag run, one open alert. */
function fixtures(dir, { eventSha, seededAlertFor }) {
  const data = path.join(dir, 'data');
  fs.mkdirSync(data, { recursive: true });

  fs.writeFileSync(path.join(data, 'commits-main.json'),
    JSON.stringify(MAIN_SHAS.map((value) => ({ sha: value }))));

  for (const value of [...MAIN_SHAS, TAG_SHA]) {
    fs.writeFileSync(path.join(data, `commit-${value}.json`),
      JSON.stringify({ commit: { committer: { date: OLD } } }));
    fs.writeFileSync(path.join(data, `checks-${value}.json`),
      JSON.stringify({ check_runs: GREEN_CHECKS }));
    fs.writeFileSync(path.join(data, `runs-${value}.json`), JSON.stringify({
      workflow_runs: [{ id: 1, name: 'Benchmark Regression', status: 'completed', conclusion: 'success', run_number: 1, run_attempt: 1, html_url: 'https://example.invalid/1' }],
    }));
  }

  // The tag's publish run failed on a later attempt, so it is not re-runnable
  // and the watcher must open a per-SHA alert for it.
  fs.writeFileSync(path.join(data, `runs-${TAG_SHA}.json`), JSON.stringify({
    workflow_runs: [{ id: 555, name: 'Publish to npm', status: 'completed', conclusion: 'failure', run_number: 21, run_attempt: 2, html_url: 'https://example.invalid/555' }],
  }));
  fs.writeFileSync(path.join(data, 'jobs.json'), JSON.stringify({ total_count: 1 }));

  const seeded = seededAlertFor
    ? [{ number: 1000, title: `ci(main): ${seededAlertFor.slice(0, 7)} has failing workflow(s)`,
        body: `Main commit \`${seededAlertFor}\` has completed workflow failures.\n\n_${MARKER}._` }]
    : [];
  fs.writeFileSync(path.join(data, 'issues-open.json'), JSON.stringify(seeded));
  fs.writeFileSync(path.join(data, 'issues-closed.json'), '[]');

  return { data, eventSha };
}

function runWatcher(t, { eventSha = '', seededAlertFor = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-main-ci-watch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fixtures(dir, { eventSha, seededAlertFor });

  const harness = `${ghShim()}\n${alertScript()}`;
  // The shell receives the fixture through the environment, so hand it a
  // forward-slash path: Git Bash accepts `C:/...` but a raw `C:\...` can lose
  // its separators. The script itself is written to a file rather than passed
  // with `-c`, because MSYS2 mangles a multi-line script that arrives as a
  // single Windows command-line argument.
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
      EVENT_SHA: eventSha,
      GH_TOKEN: 'fixture-token',
      GITHUB_STEP_SUMMARY: path.join(testDir, 'summary.md'),
    },
  });
  assert.ifError(result.error);
  const read = (file) => (fs.existsSync(path.join(dir, file))
    ? fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').filter(Boolean) : []);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, dir,
    created: read('created.log'), closed: read('closed.log'), lookedUp: read('looked-up.log') };
}

test('#4128: the watcher alerts on the triggering run when its SHA is outside the main window', { skip: SKIP }, (t) => {
  const result = runWatcher(t, { eventSha: TAG_SHA });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.lookedUp.includes(TAG_SHA),
    'the triggering run SHA must be queried, not only the latest ten main commits');
  assert.deepEqual(result.created, [`ci(main): ${TAG_SHA.slice(0, 7)} has failing workflow(s)`],
    'the tag-triggered failure must raise an alert even though its SHA is not among the latest ten main commits');
  assert.match(result.stdout, /ALL_EXPECTED_CHECKS_OBSERVED_AND_GREEN/,
    'a tag failure must not change the verdict for the latest main commit');
});

test('#4128: a green main does not close an alert that belongs to a commit outside the window', { skip: SKIP }, (t) => {
  const result = runWatcher(t, { eventSha: TAG_SHA, seededAlertFor: MAIN_SHAS[4] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ALL_EXPECTED_CHECKS_OBSERVED_AND_GREEN/);

  // The in-window alert (seeded as #1000) closes; the out-of-window tag alert
  // (created in this run as #1001) must stay open for a human to resolve.
  assert.deepEqual(result.closed, ['1000'],
    'only the alert whose commit is in the scanned main window may be auto-closed');
  const open = JSON.parse(fs.readFileSync(path.join(result.dir, 'data', 'issues-open.json'), 'utf8'));
  assert.deepEqual(open.map((issue) => issue.title),
    [`ci(main): ${TAG_SHA.slice(0, 7)} has failing workflow(s)`],
    'the tag alert survives a green main');
});

test('#4128: a schedule run inspects only the main window', { skip: SKIP }, (t) => {
  const result = runWatcher(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.created, [], 'no event SHA means no extra candidate');
  assert.deepEqual([...new Set(result.lookedUp)].sort(), [...MAIN_SHAS].sort(),
    'without a triggering run the scan is exactly the ten latest main commits');
});

test('#4128: the watcher passes the triggering run SHA through the environment', () => {
  const workflow = yaml.load(fs.readFileSync(WATCH_PATH, 'utf8'));
  const step = workflow.jobs['inspect-main'].steps
    .find((candidate) => String(candidate.name).startsWith('Re-run transient'));
  // Interpolating `${{ }}` straight into the shell would re-split and could be
  // read as an option; the env indirection keeps it a single validated word.
  assert.equal(step.env.EVENT_SHA, '${{ github.event.workflow_run.head_sha }}');
  assert.match(step.run, /event_sha="\$\{EVENT_SHA:-\}"/);
  assert.match(step.run, /for sha in "\$\{candidates\[@\]\}"; do/);
  assert.match(step.run, /latest_sha="\$\{shas\[0\]\}"/, 'the verdict stays pinned to the latest main commit');
});

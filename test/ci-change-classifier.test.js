'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'benchmark.yml');
// Normalize line endings before matching. .gitattributes pins this file to LF,
// but a clone that already checked it out under core.autocrlf=true still has
// CRLF on disk, and the marker regex below is LF-anchored. Normalizing here
// also keeps stray CR bytes out of the extracted shell, where bash would treat
// them as part of the command rather than as a line separator.
const workflow = fs.readFileSync(workflowPath, 'utf8').replace(/\r\n/g, '\n');
const marker = workflow.match(
  /^          # CI_CLASSIFIER_FUNCTIONS_START\n([\s\S]*?)^          # CI_CLASSIFIER_FUNCTIONS_END$/m,
);

assert.ok(marker, 'classifier function markers must exist in benchmark.yml');

const classifierFunctions = marker[1]
  .split('\n')
  .map((line) => line.startsWith('          ') ? line.slice(10) : line)
  .join('\n');

function usableBash() {
  const probe = spawnSync('bash', ['-c', '[ "$1" = cli.js ] && printf huqan-bash-ok', 'huqan-probe', 'cli.js'], { encoding: 'utf8' });
  return probe.status === 0 && probe.stdout === 'huqan-bash-ok';
}

function classify(file) {
  const script = `${classifierFunctions}
    runtime=no
    perf=no
    docker=no
    if is_runtime_file "$1" || is_test_file "$1"; then runtime=yes; fi
    if is_perf_file "$1"; then perf=yes; fi
    if is_docker_file "$1"; then docker=yes; fi
    printf '%s,%s,%s' "$runtime" "$perf" "$docker"
  `;
  const result = spawnSync('bash', ['-c', script, 'ci-classifier', file], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('CI classifier maps representative paths to the intended gates', (t) => {
  if (!usableBash()) return t.skip('requires a usable POSIX bash; Windows system bash.exe is not one');
  const cases = new Map([
    ['cli.js', 'yes,no,no'],
    ['lib/contradiction-rules.js', 'yes,no,no'],
    ['kernel.js', 'yes,yes,no'],
    ['test/ci-change-classifier.test.js', 'yes,no,no'],
    // #4245: a co-located test file must stay perf-neutral. `lib/provenance-*.js`
    // is a perf glob and also matches this test file, so before the guard a
    // test-only PR ran the observability soak and could fail the required
    // Benchmark gate on an unrelated cpuRatio.
    ['lib/provenance-query.test.js', 'yes,no,no'],
    ['lib/trust-policy.js', 'yes,no,no'],
    ['Dockerfile', 'no,no,yes'],
    // The manifest declares the test command and the dependency set, so a
    // change to it can alter how the whole suite runs. is_runtime_file()
    // classifies it as runtime (#752 deny-by-default), and it stays a Docker
    // surface because the image is built from it.
    ['package.json', 'yes,no,yes'],
    ['package-lock.json', 'yes,no,yes'],
    ['docs/current-operating-roadmap.md', 'no,no,no'],
  ]);

  for (const [file, expected] of cases) {
    assert.equal(classify(file), expected, file);
  }
});

function shellBlock(block) {
  return block.split('\n').map((line) => line.startsWith('          ') ? line.slice(10) : line).join('\n');
}

function sourceFlag(changed) {
  const initial = workflow.match(/^          source_only=([^\n]+)$/m);
  const loop = workflow.match(/# The ratchet runs[^]*?(^          while IFS= read -r f; do[^]*?^          done <<< "\$\{CHANGED\}")/m);
  assert.ok(initial && loop, 'the workflow must publish its source classification');
  const result = spawnSync('bash', ['-c', `${classifierFunctions}\nsource_only=${initial[1]}\n${shellBlock(loop[1])}\nprintf '%s' "$source_only"`], {
    encoding: 'utf8', env: { ...process.env, CHANGED: changed },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function coverageApplies(job, flag) {
  const block = workflow.match(new RegExp(`^  ${job}:\\n([^]*?)(?=^  [\\w-]+:|$(?![^]))`, 'm'));
  assert.ok(block, `workflow job ${job} exists`);
  const condition = block[1].match(/^    if: \$\{\{ needs\.classify\.outputs\.source_only (==|!=) '([^']+)' \}\}$/m);
  assert.ok(condition, `job ${job} must use the source classification`);
  return condition[1] === '==' ? flag === condition[2] : flag !== condition[2];
}

test('source changes run coverage and docs or test-only changes skip it', (t) => {
  if (!usableBash()) return t.skip('requires a usable POSIX bash');
  for (const [changed, expected] of [
    ['lib/memory-store.js', true], ['cli.js', true], ['scripts/run-tests.js', true],
    ['docs/architecture.md', false], ['test/graph.test.js', false],
    ['docs/architecture.md\nlib/memory-store.js', true],
  ]) {
    const flag = sourceFlag(changed);
    assert.equal(coverageApplies('coverage', flag), expected, changed);
    assert.equal(coverageApplies('coverage-skip', flag), !expected, changed);
  }
});

test('missing or invalid classification cannot select the coverage skip path', () => {
  for (const flag of ['', 'true', 'false', 'unexpected']) {
    assert.equal(coverageApplies('coverage', flag), false, flag);
    assert.equal(coverageApplies('coverage-skip', flag), false, flag);
  }
});

// #4245: the classify step must diff from the merge base. A branch that has
// fallen behind main is normal (strict_required_status_checks_policy is off),
// and a two-dot `git diff base.sha head.sha` then reports main's own newer
// commits as "changed" -- a perf-sensitive commit on main (lib/receipt/*,
// rustGraph.js) ran the soak gate on a test-only PR and failed it on an
// unrelated cpuRatio.
test('the pull request diff is taken from the merge base, not the base tip', (t) => {
  const command = workflow.match(/^\s*CHANGED=\$\(git diff --name-only "\$\{BASE_SHA\}(\.\.\.| )\$\{HEAD_SHA\}".*$/m);
  assert.ok(command, 'classify computes CHANGED with a git diff of BASE_SHA and HEAD_SHA');
  assert.equal(command[1], '...', 'the pull request diff must be three-dot (merge base), not two-dot');

  if (!usableBash()) return t.skip('requires a usable POSIX bash');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-merge-base-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  const commit = (message) => {
    git('add', '-A');
    const done = git('commit', '-q', '-m', message);
    assert.equal(done.status, 0, done.stderr);
  };

  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib', 'base.js'), 'base\n');
  commit('base');
  git('checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(dir, 'lib', 'feature.test.js'), 'test\n');
  commit('test-only change');
  git('checkout', '-q', 'main');
  fs.mkdirSync(path.join(dir, 'lib', 'receipt'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib', 'receipt', 'perf.js'), 'perf\n');
  commit('perf-sensitive change on main');

  const baseTip = git('rev-parse', 'main').stdout.trim();
  const headTip = git('rev-parse', 'feature').stdout.trim();
  const shell = shellBlock(command[0]).replace(/^\s*CHANGED=/, 'CHANGED=');
  const result = spawnSync('bash', ['-c', `${shell}\nprintf '%s' "$CHANGED"`], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, BASE_SHA: baseTip, HEAD_SHA: headTip },
  });
  assert.equal(result.status, 0, result.stderr);
  const changed = result.stdout.split('\n').filter(Boolean).sort();
  assert.deepEqual(changed, ['lib/feature.test.js'],
    'a behind-main PR must not report main\'s own perf-sensitive files as changed');
});

test('coverage gate requires the matching run path and rejects missing classification', (t) => {
  if (!usableBash()) return t.skip('requires a usable POSIX bash');
  const gate = workflow.match(/^  coverage-gate:\n([^]*?)(?=^  [\w-]+:|$(?![^]))/m);
  // The gate now carries the #3970 unresolved-alarm step after the acceptance
  // check, so the extraction must stop at the next step or job-level line;
  // the matrix below replays the first step's shell, and only that shell.
  // The end alternative is a real end-of-string assertion (?![\s\S]), not $:
  // with /m a bare $ matches before every newline and would stop the lazy
  // capture after the shell's first line.
  const run = gate?.[1].match(/^        run: \|\n([^]*?)(?=\n      (?:- |#)|\n  [\w-]+:|(?![\s\S]))/m);
  assert.ok(run, 'coverage gate has a shell acceptance check');
  assert.match(gate[1], /SOURCE_ONLY: \$\{\{ needs\.classify\.outputs\.source_only \}\}/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-coverage-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'gate.sh');
  fs.writeFileSync(script, shellBlock(run[1]));
  for (const [source, coverage, skip, classify, expected] of [
    ['yes', 'success', 'skipped', 'success', true],
    ['no', 'skipped', 'success', 'success', true],
    ['yes', 'skipped', 'success', 'success', false],
    ['no', 'success', 'skipped', 'success', false],
    ['yes', 'failure', 'skipped', 'success', false],
    ['no', 'skipped', 'failure', 'success', false],
    ['', 'skipped', 'success', 'success', false],
    ['unexpected', 'success', 'success', 'success', false],
    ['yes', 'success', 'skipped', 'failure', false],
  ]) {
    const result = spawnSync('bash', [script], { encoding: 'utf8', env: {
      ...process.env, SOURCE_ONLY: source, COVERAGE_RESULT: coverage,
      SKIP_RESULT: skip, CLASSIFY_RESULT: classify,
    } });
    assert.equal(result.error, undefined, `bash execution: ${result.error}`);
    assert.equal(result.status === 0, expected, `${source}/${coverage}/${skip}/${classify}: ${result.stderr}`);
  }
});

'use strict';

// #4006: the traceability gate must refuse a defect fix that names no
// regression test, and must not refuse the changes it is not about. Each test
// below pins one of those two directions.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DECLARATION_LABEL,
  MIN_WAIVER_REASON,
  changedFilesFrom,
  conventionalType,
  evaluateTraceability,
  isDefectFix,
  isDocumentationOnly,
  issueReferences,
  main,
  parseDeclaration,
} = require('../scripts/check-issue-regression-traceability');

const REPO_ROOT = path.resolve(__dirname, '..');
// A real, discovered test file: the existence and discovery probes run against
// the repository, not a fixture, so the gate is exercised as CI runs it.
const EXISTING_TEST = 'test/coverage-gate-history.test.js';
const SECOND_TEST = 'test/ci-change-classifier.test.js';

function verdict(overrides = {}) {
  return evaluateTraceability({
    title: 'fix(ci): keep an unresolved coverage alarm red',
    body: 'Closes #3970\n\nRegression-Test: ' + EXISTING_TEST + '\n',
    changedFiles: ['scripts/coverage-gate-history.js'],
    knownTests: [EXISTING_TEST, SECOND_TEST],
    selectedTests: [EXISTING_TEST],
    ...overrides,
  });
}

test('the conventional type is read from the title, ignoring an optional scope', () => {
  assert.equal(conventionalType('fix(ci): x'), 'fix');
  assert.equal(conventionalType('fix: x'), 'fix');
  assert.equal(conventionalType('fix(ci)!: x'), 'fix');
  assert.equal(conventionalType('  security: x'), 'security');
  assert.equal(conventionalType('Update the thing'), null);
});

test('only fix, security and hotfix are treated as defect fixes', () => {
  for (const title of ['fix(a): b', 'security: b', 'hotfix: b']) {
    assert.equal(isDefectFix(title), true, title);
  }
  for (const title of ['feat(a): b', 'test: b', 'chore: b', 'docs: b', 'ci: b', 'perf: b', 'refactor: b', 'Update the thing']) {
    assert.equal(isDefectFix(title), false, title);
  }
});

test('a documentation-only change is exempt, a code change is not', () => {
  assert.equal(isDocumentationOnly(['docs/architecture.md']), true);
  assert.equal(isDocumentationOnly(['README.md', 'docs/x.md']), true);
  assert.equal(isDocumentationOnly(['docs/x.md', 'lib/http/route-auth-policy.js']), false);
  // An empty change set claims nothing, so it is not exempt.
  assert.equal(isDocumentationOnly([]), false);
});

test('issue references are collected from a title and body', () => {
  assert.deepEqual(issueReferences('fix: x (#4006)'), [4006]);
  assert.deepEqual(issueReferences('Closes #3970, relates to #3971'), [3970, 3971]);
  assert.deepEqual(issueReferences('no reference here'), []);
});

test('the declaration parses a test list, a waiver, and an unreadable line', () => {
  assert.deepEqual(parseDeclaration('Regression-Test: test/a.test.js').tests, ['test/a.test.js']);
  assert.deepEqual(parseDeclaration('regression-test: test/a.test.js, test/b.test.js').tests, ['test/a.test.js', 'test/b.test.js']);

  const waiver = parseDeclaration('Regression-Test: none -- only rewords a refusal message');
  assert.equal(waiver.status, 'waiver');
  assert.equal(waiver.reason, 'only rewords a refusal message');

  const bare = parseDeclaration('Regression-Test: none');
  assert.equal(bare.status, 'waiver');
  assert.equal(bare.reason, '');

  // A label with nothing after it is not a waiver and not a test: it is
  // unreadable, and the author is told which.
  const empty = parseDeclaration('Regression-Test:');
  assert.equal(empty.status, 'invalid');
  assert.match(empty.error, /names no test file/);

  assert.equal(parseDeclaration('no declaration at all').status, 'missing');
});

test('the files payload is flattened from the single-page and slurped shapes', () => {
  assert.deepEqual(changedFilesFrom([{ filename: 'b.js' }, { filename: 'a.js' }]), ['a.js', 'b.js']);
  assert.deepEqual(changedFilesFrom([[{ filename: 'a.js' }], [{ filename: 'b.js' }]]), ['a.js', 'b.js']);
  assert.equal(changedFilesFrom({ files: [] }), null);
});

test('a defect fix with a declared, selected test passes', () => {
  const result = verdict();
  assert.equal(result.required, true);
  assert.equal(result.ok, true);
  assert.deepEqual(result.tests, [EXISTING_TEST]);
});

test('a defect fix with no declaration fails, naming the label', () => {
  const result = verdict({ body: 'Closes #3970\n' });
  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), new RegExp(DECLARATION_LABEL));
});

test('a declared test that does not exist fails', () => {
  const result = verdict({ body: 'Closes #3970\n\nRegression-Test: test/does-not-exist.test.js\n' });
  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), /does not exist/);
});

test('a declared file that CI discovery does not run fails', () => {
  const result = verdict({ body: 'Closes #3970\n\nRegression-Test: scripts/spawn-windows-aware.js\n' });
  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), /not a discovered test file/);
});

test('a declared test outside the applicable CI path fails, unless it is added by the pull request', () => {
  const outside = verdict({ body: 'Closes #3970\n\nRegression-Test: ' + SECOND_TEST + '\n' });
  assert.equal(outside.ok, false);
  assert.match(outside.failures.join('\n'), /not selected by the impact plan/);

  const added = verdict({
    body: 'Closes #3970\n\nRegression-Test: ' + SECOND_TEST + '\n',
    changedFiles: ['scripts/coverage-gate-history.js', SECOND_TEST],
  });
  assert.equal(added.ok, true, 'a test the pull request adds is on the applicable path by definition');
});

test('a full-suite plan accepts any discovered test', () => {
  const result = verdict({
    body: 'Closes #3970\n\nRegression-Test: ' + SECOND_TEST + '\n',
    fullSuite: true,
  });
  assert.equal(result.ok, true);
});

test('a defect fix that names no issue fails even with a declared test', () => {
  const result = verdict({ title: 'fix(ci): x', body: 'Regression-Test: ' + EXISTING_TEST + '\n' });
  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), /names no issue/);
});

test('an invalid declaration fails with the parser error, not a missing-line message', () => {
  const result = verdict({ body: 'Closes #3970\n\nRegression-Test:\n' });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'invalid');
  assert.match(result.failures.join('\n'), /names no test file/);
});

test('a declared path that escapes the repository or is a directory fails', () => {
  const escaping = verdict({ body: 'Closes #3970\n\nRegression-Test: ../outside.test.js\n' });
  assert.equal(escaping.ok, false);
  assert.match(escaping.failures.join('\n'), /repository-relative/);

  const absolute = verdict({ body: `Closes #3970\n\nRegression-Test: /etc/hostname\n` });
  assert.equal(absolute.ok, false);
  assert.match(absolute.failures.join('\n'), /repository-relative/);

  const directory = verdict({ body: 'Closes #3970\n\nRegression-Test: test\n' });
  assert.equal(directory.ok, false);
  assert.match(directory.failures.join('\n'), /not a file/);
});

test('a waiver with a substantive reason passes and a bare waiver fails', () => {
  const good = verdict({ body: 'Closes #3970\n\nRegression-Test: none -- only rewords a refusal message\n' });
  assert.equal(good.ok, true);
  assert.equal(good.kind, 'waiver');

  const bad = verdict({ body: 'Closes #3970\n\nRegression-Test: none\n' });
  assert.equal(bad.ok, false);
  assert.match(bad.failures.join('\n'), new RegExp(`at least ${MIN_WAIVER_REASON} characters`));
});

test('an enhancement or a documentation-only change is exempt, not waived', () => {
  assert.equal(verdict({ title: 'feat(ci): x', body: '' }).required, false);
  assert.equal(verdict({ body: '', changedFiles: ['docs/architecture.md'] }).required, false);
});

test('the CLI passes a fix that declares a test it also adds', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-traceability-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const prFile = path.join(dir, 'pr.json');
  const filesFile = path.join(dir, 'files.json');
  fs.writeFileSync(prFile, JSON.stringify({
    title: 'fix(ci): keep an unresolved coverage alarm red',
    body: `Closes #3970\n\n${DECLARATION_LABEL}: ${EXISTING_TEST}\n`,
  }));
  fs.writeFileSync(filesFile, JSON.stringify([
    { filename: 'scripts/coverage-gate-history.js' },
    { filename: EXISTING_TEST },
  ]));
  assert.equal(main([prFile, filesFile]), 0);
});

test('the CLI fails a fix with no declaration and a non-array files payload', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-traceability-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const prFile = path.join(dir, 'pr.json');
  const filesFile = path.join(dir, 'files.json');
  const badFiles = path.join(dir, 'bad.json');
  fs.writeFileSync(prFile, JSON.stringify({ title: 'fix(ci): x', body: 'Closes #3970\n' }));
  fs.writeFileSync(filesFile, JSON.stringify([{ filename: 'scripts/coverage-gate-history.js' }]));
  fs.writeFileSync(badFiles, JSON.stringify({ files: [] }));

  const errors = [];
  t.mock.method(process.stderr, 'write', (chunk) => { errors.push(String(chunk)); return true; });
  assert.equal(main([prFile, filesFile]), 1, 'a missing declaration fails');
  assert.match(errors.join(''), new RegExp(DECLARATION_LABEL));
  assert.equal(main([prFile, badFiles]), 2, 'a non-array files payload is a usage error');
  assert.equal(main([prFile]), 2, 'a missing argument is a usage error');
  assert.equal(main([path.join(dir, 'missing.json'), filesFile]), 2, 'an unreadable payload is a usage error');
  t.mock.restoreAll();
});

test('the CLI builds the impact plan when the declared test is not added by the pull request', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-traceability-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const prFile = path.join(dir, 'pr.json');
  const filesFile = path.join(dir, 'files.json');
  // The changed file is a real production module and the declared test is a
  // real test the impact plan selects for it, but the pull request does not add
  // the test itself -- so the plan has to be built to accept the declaration.
  fs.writeFileSync(prFile, JSON.stringify({
    title: 'fix(ci): keep an unresolved coverage alarm red',
    body: `Closes #3970\n\n${DECLARATION_LABEL}: ${EXISTING_TEST}\n`,
  }));
  fs.writeFileSync(filesFile, JSON.stringify([{ filename: 'scripts/coverage-gate-history.js' }]));
  assert.equal(main([prFile, filesFile]), 0);
});

test('the CLI accepts a documented waiver and exempts an enhancement', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-traceability-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filesFile = path.join(dir, 'files.json');
  fs.writeFileSync(filesFile, JSON.stringify([{ filename: 'scripts/coverage-gate-history.js' }]));

  const waiver = path.join(dir, 'waiver.json');
  fs.writeFileSync(waiver, JSON.stringify({
    title: 'fix(ci): x',
    body: 'Closes #3970\n\nRegression-Test: none -- only rewords a refusal message\n',
  }));
  assert.equal(main([waiver, filesFile]), 0);

  const enhancement = path.join(dir, 'feat.json');
  fs.writeFileSync(enhancement, JSON.stringify({ title: 'feat(ci): x', body: '' }));
  assert.equal(main([enhancement, filesFile]), 0);
});

// The workflow contract: the gate runs on every pull request, from the
// workflow-governance job, and reads the two payloads it needs.
test('workflow-governance.yml runs the traceability check on every pull request', () => {
  const yaml = require('js-yaml');
  const workflow = yaml.load(fs.readFileSync(
    path.join(REPO_ROOT, '.github', 'workflows', 'workflow-governance.yml'), 'utf8',
  ));
  const on = workflow.on ?? workflow[true];
  assert.ok('pull_request' in on, 'the check must run on every pull request, unfiltered');
  assert.equal(on.pull_request, null, 'a branch filter would let a stacked PR skip the check');

  const steps = (workflow.jobs.governance.steps || []).map((step) => step.run || '').join('\n');
  assert.match(steps, /scripts\/check-issue-regression-traceability\.js/);
  assert.match(steps, /pulls\/\$\{PR_NUMBER\}\/files/, 'the changed files must be fetched');
});

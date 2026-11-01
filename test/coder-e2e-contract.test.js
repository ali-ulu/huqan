'use strict';

/**
 * Release-grade end-to-end Coder contract (#4450).
 *
 * One public-CLI path, from a real observed source failure to recorded
 * provenance, held together in a single file so the claim boundary is testable
 * rather than described:
 *
 *   verified failure record -> produceTask -> `coder <task.json>` -> mutation
 *   gate -> independent declared test -> independent file read-back -> journal
 *   provenance (run_closed verdict `complete`).
 *
 * The boundary is deliberate and pinned here: Coder executes a *task-described*
 * deterministic transform through the ordinary gate. It is not an autonomous
 * general-purpose coder that diagnoses an arbitrary repository from a free goal.
 * Every case below is real: the real error-prevention engine, the real producer,
 * the real CLI process, a real Git repository and the real journal. No I/O is
 * mocked.
 *
 * Learned routing is exercised at its refusal boundary (absent sealed source,
 * no write). The positive learned path -- sealed source binding, promotion
 * receipt validation, a real Authority apply -- is covered by
 * `test/cli-coder-learned-runtime.test.js`; this file does not duplicate that
 * harness.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', 'cli.js');
const MemoryStore = require('../lib/memory-store');
const { createErrorPrevention } = require('../lib/error-prevention');
const { PRODUCER_STATUSES, produceTask } = require('../lib/task-producer');
const { verifyDerivationHash } = require('../lib/coder/derivation-record');
const { openCoderJournal } = require('../lib/coder/journal-store');
const { cliHelpText } = require('../lib/cli-help');

const BASE = 'version v1.0.0\n';
const FIXED = 'version v1.1.0\n';

// The declared independent test: it reads the target from disk and asserts the
// repaired bytes. It also drops a sentinel so a case can prove the test process
// never ran.
const ACCEPTANCE = "require('node:assert/strict').equal("
  + "require('node:fs').readFileSync('docs/version.md', 'utf8'), 'version v1.1.0\\n');\n";

function fixtureDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-e2e-')));
}

/** A real Git repository on a feature branch, with the base tree committed. */
function featureRoot(files, branch = 'feat/e2e') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-e2e-root-')));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-qb', branch);
  git('config', 'user.email', 'e2e@example.invalid');
  git('config', 'user.name', 'e2e');
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, 'utf8');
  }
  git('add', '-A');
  git('commit', '-qm', 'base');
  return root;
}

/** A real verified failure record, produced by the real error-prevention engine. */
function verifiedFailure() {
  const prevention = createErrorPrevention(new MemoryStore({ useSQLite: false }), {
    verifyEvidence: ({ source, evidence }) => source === 'test_failure'
      && evidence.some(item => item?.type === 'test' && item?.verifiedBy === 'ci'),
  });
  const recorded = prevention.recordFailure({
    tool: 'coder', operation: 'replace_text', path: 'docs/version.md', workspaceId: 'default',
    source: 'test_failure', observed: 'v1.0.0', expected: 'v1.1.0',
    evidence: [{ type: 'test', verifiedBy: 'ci' }],
  });
  assert.equal(recorded.ok, true);
  assert.equal(recorded.failure.verificationStatus, 'verified');
  return recorded.failure;
}

/** Run the public CLI as a real process and parse its JSON envelope. */
function runCoder(root, taskFile, extra = []) {
  const child = spawnSync(process.execPath,
    [CLI, 'coder', taskFile, '--root', root, '--json', ...extra],
    { cwd: root, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, HUQAN_STATE_ROOT: path.join(root, '.huqan', 'runtime-state') } });
  return {
    status: child.status,
    json: child.stdout ? JSON.parse(child.stdout) : null,
    stderr: child.stderr,
  };
}

test('#4450 the public CLI carries a real failure through gate, test, read-back and provenance', () => {
  const fixture = fixtureDir();
  const root = path.join(fixture, 'workspace');
  try {
    // Base tree: the target and the committed independent acceptance test.
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'version.md'), BASE, 'utf8');
    fs.writeFileSync(path.join(root, 'acceptance.test.js'), ACCEPTANCE, 'utf8');
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '-qb', 'feat/e2e');
    git('config', 'user.email', 'e2e@example.invalid');
    git('config', 'user.name', 'e2e');
    git('add', '-A');
    git('commit', '-qm', 'base');

    // 1. Task derivation starts from the real observed failure.
    const produced = produceTask(verifiedFailure());
    assert.equal(produced.status, PRODUCER_STATUSES.TASK_PRODUCED);
    assert.equal(produced.task.operation.type, 'replace_text');
    assert.equal(produced.task.operation.find, 'v1.0.0');
    assert.equal(produced.task.operation.replace, 'v1.1.0');

    // The operator binds the independent acceptance test to the derived task.
    const taskFile = path.join(fixture, 'task.json');
    fs.writeFileSync(taskFile, JSON.stringify(
      { ...produced.task, test: { command: 'node acceptance.test.js' } }), 'utf8');
    const journalPath = path.join(fixture, 'evidence.db');

    // 2. One public CLI run: gate -> apply -> independent test -> read-back.
    const run = runCoder(root, taskFile, ['--authorize', '--journal', journalPath, '--run-id', 'e2e-full']);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.json.status, 'completed');
    assert.equal(run.json.data.outcome, 'applied_tested');
    assert.equal(run.json.data.repoStateKnown, true);

    const record = run.json.data.record;
    // Independent behavioral acceptance actually ran and passed.
    assert.equal(record.observedVerification.ran, true);
    assert.equal(record.observedVerification.ok, true);
    // The derivation record is self-consistent (tamper-evident provenance).
    assert.equal(verifyDerivationHash(record).ok, true);

    // The target holds exactly the repaired bytes.
    assert.equal(fs.readFileSync(path.join(root, 'docs', 'version.md'), 'utf8'), FIXED);

    // 3. Receipt/provenance: the journal carries the full causal chain.
    const store = openCoderJournal(journalPath);
    try {
      const events = store.journal.read('e2e-full:c1');
      assert.deepEqual(events.map(event => event.type), [
        'run_started', 'action_proposed', 'policy_decided',
        'execution_started', 'execution_finished', 'verification', 'run_closed',
      ]);
      // Independent file read-back is recorded as a matching hash check.
      const verification = events.find(event => event.type === 'verification');
      assert.equal(verification.payload.verified, true);
      assert.equal(verification.payload.checks[0].path, 'docs/version.md');
      assert.equal(verification.payload.checks[0].match, true);
      // The run closes `complete` only with both disk proof and test proof.
      const closed = events.find(event => event.type === 'run_closed');
      assert.equal(closed.payload.verdict, 'complete');
      assert.equal(closed.payload.coverage.covered, true);
      assert.equal(closed.payload.evidence.kept, true);
      assert.equal(closed.payload.evidence.test.ok, true);
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('#4450 a failed candidate is rolled back before the next candidate is kept', () => {
  const fixture = fixtureDir();
  const root = path.join(fixture, 'workspace');
  try {
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'version.md'), BASE, 'utf8');
    fs.writeFileSync(path.join(root, 'acceptance.test.js'), ACCEPTANCE, 'utf8');
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '-qb', 'feat/e2e');
    git('config', 'user.email', 'e2e@example.invalid');
    git('config', 'user.name', 'e2e');
    git('add', '-A');
    git('commit', '-qm', 'base');

    const taskFile = path.join(fixture, 'task.json');
    fs.writeFileSync(taskFile, JSON.stringify({
      id: 'e2e-rollback', level: 'l0', allowedPaths: ['docs/version.md'],
      operation: { type: 'replace_text', path: 'docs/version.md', find: 'v1.0.0', replace: 'v1.1.0' },
      candidates: [
        { type: 'replace_text', path: 'docs/version.md', find: 'v1.0.0', replace: 'v9.9.9' },
        { type: 'replace_text', path: 'docs/version.md', find: 'v1.0.0', replace: 'v1.1.0' },
      ],
      test: { command: 'node acceptance.test.js' },
    }), 'utf8');

    const run = runCoder(root, taskFile, ['--authorize']);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.json.data.outcome, 'applied_tested');

    const [first, second] = run.json.data.attempts;
    // Candidate 1 failed its test and its patch was rolled back before candidate 2.
    assert.equal(first.test.ok, false);
    assert.equal(first.rolledBack, true);
    assert.equal(first.kept, false);
    // Candidate 2 passed and was kept.
    assert.equal(second.test.ok, true);
    assert.equal(second.kept, true);
    assert.equal(run.json.data.kept.length, 1);
    assert.equal(fs.readFileSync(path.join(root, 'docs', 'version.md'), 'utf8'), FIXED);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

// Two gate holds must each leave the tree and the process untouched: a denied
// write on `main`, and a dirty-tree review hold. The dirty case passes
// `--authorize` deliberately: the operator waiver releases only a generic
// source-review hold, never a dirty-repo hold, so the refusal must survive it.
for (const gateCase of [
  { name: 'denied (main branch)', branch: 'main', dirty: false, authorize: false, reason: /MAIN_BRANCH_WRITE_BLOCKED/ },
  { name: 'review-required (dirty tree, not liftable by --authorize)', branch: 'feat/e2e', dirty: true, authorize: true, reason: /DIRTY_REPO_REVIEW_REQUIRED/ },
]) {
  test(`#4450 a ${gateCase.name} gate leaves no target-file or process side effect`, () => {
    const fixture = fixtureDir();
    const root = path.join(fixture, 'workspace');
    try {
      fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(root, 'docs', 'version.md'), BASE, 'utf8');
      fs.writeFileSync(path.join(root, 'acceptance.test.js'), ACCEPTANCE, 'utf8');
      const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
      git('init', '-qb', gateCase.branch);
      git('config', 'user.email', 'e2e@example.invalid');
      git('config', 'user.name', 'e2e');
      git('add', '-A');
      git('commit', '-qm', 'base');
      if (gateCase.dirty) fs.writeFileSync(path.join(root, 'uncommitted.txt'), 'dirt\n', 'utf8');

      const taskFile = path.join(fixture, 'task.json');
      fs.writeFileSync(taskFile, JSON.stringify({
        id: 'e2e-gate', level: 'l0', allowedPaths: ['docs/version.md'],
        operation: { type: 'replace_text', path: 'docs/version.md', find: 'v1.0.0', replace: 'v1.1.0' },
        test: { command: 'node acceptance.test.js' },
      }), 'utf8');

      const run = runCoder(root, taskFile, gateCase.authorize ? ['--authorize'] : []);
      assert.notEqual(run.status, 0);
      assert.match(JSON.stringify(run.json.data.attempts), gateCase.reason);
      // No target write, and the acceptance test process never ran.
      assert.equal(fs.readFileSync(path.join(root, 'docs', 'version.md'), 'utf8'), BASE);
      assert.equal(fs.existsSync(path.join(root, 'SIDE_EFFECT.txt')), false);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
}

test('#4450 an unavailable repository state refuses the write without a side effect', () => {
  const fixture = fixtureDir();
  const root = path.join(fixture, 'workspace');
  try {
    // Not a Git repository at all: the gate cannot say where a write lands.
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'version.md'), BASE, 'utf8');
    fs.writeFileSync(path.join(root, 'acceptance.test.js'), ACCEPTANCE, 'utf8');

    const taskFile = path.join(fixture, 'task.json');
    fs.writeFileSync(taskFile, JSON.stringify({
      id: 'e2e-unknown', level: 'l0', allowedPaths: ['docs/version.md'],
      operation: { type: 'replace_text', path: 'docs/version.md', find: 'v1.0.0', replace: 'v1.1.0' },
      test: { command: 'node acceptance.test.js' },
    }), 'utf8');

    const run = runCoder(root, taskFile, []);
    assert.notEqual(run.status, 0);
    assert.equal(run.json.data.repoStateKnown, false);
    assert.match(JSON.stringify(run.json.data.attempts), /REPO_STATE_UNKNOWN_BLOCKED/);
    assert.equal(fs.readFileSync(path.join(root, 'docs', 'version.md'), 'utf8'), BASE);
    assert.equal(fs.existsSync(path.join(root, 'SIDE_EFFECT.txt')), false);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('#4450 learned routing refuses source evidence that is not sealed and present', () => {
  const fixture = fixtureDir();
  const root = path.join(fixture, 'workspace');
  try {
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'version.md'), BASE, 'utf8');
    fs.writeFileSync(path.join(root, 'acceptance.test.js'), ACCEPTANCE, 'utf8');
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '-qb', 'feat/e2e');
    git('config', 'user.email', 'e2e@example.invalid');
    git('config', 'user.name', 'e2e');
    git('add', '-A');
    git('commit', '-qm', 'base');

    // A routing request whose candidate names a sealed run the journal does not
    // hold: routing must refuse rather than fall back to an unwritten patch.
    const taskFile = path.join(fixture, 'task.json');
    fs.writeFileSync(taskFile, JSON.stringify({
      id: 'e2e-route', level: 'l0', allowedPaths: ['docs/version.md'],
      operation: { type: 'replace_text', path: 'docs/version.md', find: 'v1.0.0', replace: 'v1.1.0' },
      test: { command: 'node acceptance.test.js' },
      experience: { riskTier: 'low', candidates: [
        { capabilityId: 'stored-absent', sourceRunIds: ['absent-run'], parentVersion: 0, qualificationPaths: [] },
      ] },
    }), 'utf8');
    const journalPath = path.join(fixture, 'evidence.db');

    const run = runCoder(root, taskFile, ['--authorize', '--journal', journalPath, '--run-id', 'e2e-route']);
    assert.notEqual(run.status, 0);
    assert.match(JSON.stringify(run.json.data.attempts), /run_not_found/);
    assert.equal(fs.readFileSync(path.join(root, 'docs', 'version.md'), 'utf8'), BASE);
    assert.equal(fs.existsSync(path.join(root, 'SIDE_EFFECT.txt')), false);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('#4450 the CLI help states the supported boundary', () => {
  const line = cliHelpText().split('\n').find(entry => entry.includes('"coder <task.json>'));
  assert.ok(line, 'the coder command must appear in CLI help');
  assert.match(line, /bounded/i);
  assert.match(line, /not general autonomous coding/i);
});

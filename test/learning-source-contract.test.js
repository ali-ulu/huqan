'use strict';

/**
 * #4599 — a verified failure may only become a learning-eligible task when an
 * independent acceptance oracle is present. These tests use the real producer,
 * the real contract and the real CLI; nothing here stubs the decision.
 *
 * Oracle independence comes from the environment, never from the source file:
 * `--source` reads a caller-selected file, so a label inside it is written by
 * whoever proposes the task.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', 'cli.js');
const MemoryStore = require('../lib/memory-store');
const { createErrorPrevention } = require('../lib/error-prevention');
const { PRODUCER_STATUSES, produceTask } = require('../lib/task-producer');
const {
  CODES, ELIGIBILITY, SUPPLY_CHANNELS, ACCEPTANCE_ENV,
  sealedFailureHash, resolveLearningSource, attachLearningSource,
} = require('../lib/experience/learning-source');
const { LEARNING_ELIGIBILITY } = require('../lib/experience/contract');

const ENV = Object.freeze({ [ACCEPTANCE_ENV.CHANNEL]: SUPPLY_CHANNELS.CI });

function verifiedFailure(overrides = {}) {
  const prevention = createErrorPrevention(new MemoryStore({ useSQLite: false }), {
    verifyEvidence: ({ source, evidence }) => source === 'test_failure'
      && evidence.some((item) => item?.type === 'test' && item?.verifiedBy === 'ci'),
  });
  const recorded = prevention.recordFailure({
    tool: 'coder', operation: 'replace_text', path: 'docs/version.md', workspaceId: 'default',
    source: 'test_failure', observed: 'v1.0.0', expected: 'v1.1.0',
    evidence: [{ type: 'test', verifiedBy: 'ci' }], ...overrides,
  });
  assert.equal(recorded.ok, true, `fixture failure must record: ${JSON.stringify(recorded)}`);
  return recorded.failure;
}

const COMMAND = 'node --test test/version.test.js';

function sourceFor(failure, overrides = {}) {
  return {
    hash: sealedFailureHash(failure),
    outcomeStatus: 'verified',
    allowedPaths: ['docs/version.md'],
    oracle: { command: COMMAND },
    ...overrides,
  };
}

test('the eligibility vocabulary is the journal contract\'s, not a private copy', () => {
  // canary.js and capability-trust.js compare against the contract's exact
  // strings; a private spelling would publish a value nothing downstream reads.
  assert.deepEqual(ELIGIBILITY, LEARNING_ELIGIBILITY);
  assert.equal(ELIGIBILITY.INELIGIBLE, 'ineligible');
  const failure = verifiedFailure();
  const refused = resolveLearningSource({
    failure, source: sourceFor(failure, { hash: 'b'.repeat(64) }), environment: ENV,
  });
  assert.equal(refused.eligibility, LEARNING_ELIGIBILITY.INELIGIBLE);
});

test('a verified failure with an independent oracle resolves as a positive procedure', () => {
  const failure = verifiedFailure();
  const resolved = resolveLearningSource({ failure, source: sourceFor(failure), environment: ENV });
  assert.equal(resolved.ok, true, resolved.code);
  assert.equal(resolved.eligibility, ELIGIBILITY.POSITIVE_PROCEDURE);
  assert.equal(resolved.test.command, COMMAND);
  assert.match(resolved.evidence.sourceHash, /^[a-f0-9]{64}$/u);
  assert.equal(resolved.evidence.oracle.channel, SUPPLY_CHANNELS.CI);
});

test('the sealed source hash is stable and covers the evidence, not the clock', () => {
  const failure = verifiedFailure();
  assert.equal(sealedFailureHash(failure), sealedFailureHash({ ...failure }));
  assert.notEqual(sealedFailureHash(failure), sealedFailureHash({ ...failure, observed: 'v9.9.9' }));
  // recordedAt is a timestamp, not evidence: two identical observations taken at
  // different times must bind to the same source.
  assert.equal(sealedFailureHash(failure),
    sealedFailureHash({ ...failure, recordedAt: '2000-01-01T00:00:00.000Z' }));
});

test('every field the producer reads is inside the sealed hash', () => {
  // A multi-file rename is driven by action.paths and create_file by
  // payload.content. Either left outside the hash would let a swapped failure
  // keep an older failure's hash and inherit its eligibility.
  const failure = verifiedFailure();
  const base = sealedFailureHash(failure);

  const renamed = { ...failure, action: { ...failure.action, paths: ['src/a.js', 'src/b.js'] } };
  assert.notEqual(sealedFailureHash(renamed), base, 'action.paths must be sealed');

  const reordered = { ...failure, action: { ...failure.action, paths: ['src/b.js', 'src/a.js'] } };
  assert.notEqual(sealedFailureHash(reordered), sealedFailureHash(renamed),
    'path order is part of the observation');

  const created = { ...failure, payload: { content: 'module.exports = 1;\n' } };
  assert.notEqual(sealedFailureHash(created), base, 'payload.content must be sealed');
  assert.notEqual(sealedFailureHash({ ...failure, payload: { content: 'other\n' } }),
    sealedFailureHash(created));
});

test('oracle independence comes from a channel the proposing agent cannot write', () => {
  const failure = verifiedFailure();

  // No channel: a label in the source file proves nothing.
  const unverified = resolveLearningSource({ failure, source: sourceFor(failure), environment: {} });
  assert.equal(unverified.ok, false);
  assert.equal(unverified.code, CODES.ORACLE_SUPPLY_UNVERIFIED);

  // The file admits where it came from; that is still not independence.
  const fromFile = resolveLearningSource({
    failure, source: sourceFor(failure), environment: { [ACCEPTANCE_ENV.CHANNEL]: SUPPLY_CHANNELS.SOURCE_FILE },
  });
  assert.equal(fromFile.code, CODES.ORACLE_NOT_INDEPENDENT);

  for (const channel of ['huqan', 'agent', 'model', 'openhands']) {
    const resolved = resolveLearningSource({
      failure, source: sourceFor(failure), environment: { [ACCEPTANCE_ENV.CHANNEL]: channel },
    });
    assert.equal(resolved.code, CODES.ORACLE_NOT_INDEPENDENT, `channel "${channel}" must be refused`);
  }

  // A self-declared supplier in the file cannot agree its way into eligibility.
  const selfDeclared = resolveLearningSource({
    failure,
    source: sourceFor(failure, { oracle: { command: COMMAND, suppliedBy: 'huqan' } }),
    environment: ENV,
  });
  assert.equal(selfDeclared.code, CODES.ORACLE_SUPPLY_UNVERIFIED);

  // A CI job that hands over a different command than the file declares is
  // ambiguous evidence, not a tie-break.
  const conflicting = resolveLearningSource({
    failure, source: sourceFor(failure),
    environment: { ...ENV, [ACCEPTANCE_ENV.COMMAND]: 'node --test test/other.test.js' },
  });
  assert.equal(conflicting.code, CODES.ORACLE_SUPPLY_UNVERIFIED);
});

test('a missing oracle, a hash mismatch and an unverified failure all fail closed', () => {
  const failure = verifiedFailure();
  const noOracle = resolveLearningSource({
    failure, source: sourceFor(failure, { oracle: undefined }), environment: ENV,
  });
  assert.equal(noOracle.code, CODES.ORACLE_MISSING);

  const blankCommand = resolveLearningSource({
    failure, source: sourceFor(failure, { oracle: { command: '   ' } }), environment: ENV,
  });
  assert.equal(blankCommand.code, CODES.ORACLE_MISSING);

  const wrongHash = resolveLearningSource({
    failure, source: sourceFor(failure, { hash: 'a'.repeat(64) }), environment: ENV,
  });
  assert.equal(wrongHash.code, CODES.SOURCE_HASH_MISMATCH);

  const unverified = resolveLearningSource({
    failure: { ...failure, verificationStatus: 'candidate' }, source: sourceFor(failure), environment: ENV,
  });
  assert.equal(unverified.code, CODES.FAILURE_NOT_VERIFIED);
});

test('a path outside the declared allowed paths is refused', () => {
  const failure = verifiedFailure();
  const escaped = resolveLearningSource({
    failure, source: sourceFor(failure, { allowedPaths: ['src/other.js'] }), environment: ENV,
  });
  assert.equal(escaped.code, CODES.PATH_NOT_ALLOWED);

  const absolute = resolveLearningSource({
    failure, source: sourceFor(failure, { allowedPaths: ['/etc/passwd'] }), environment: ENV,
  });
  assert.equal(absolute.code, CODES.ALLOWED_PATHS_INVALID);
});

test('a multi-file rename must declare every one of its targets', () => {
  // A rename has no action.path; its targets live in action.paths. Checking
  // only action.path would skip the whole record.
  //
  // `recordFailure` does not carry `paths` today, so the record is written out
  // literally: the contract validates records from any source, and a record
  // that reaches it from elsewhere must still be checked.
  const base = verifiedFailure();
  const failure = {
    ...base,
    action: { ...base.action, operation: 'rename_identifier', path: '', paths: ['src/a.js', 'src/b.js'] },
    observed: 'oldName',
    expected: 'newName',
  };

  const undeclared = resolveLearningSource({
    failure,
    source: sourceFor(failure, { allowedPaths: ['src/a.js'] }),
    environment: ENV,
  });
  assert.equal(undeclared.code, CODES.PATH_NOT_ALLOWED);

  const declared = resolveLearningSource({
    failure,
    source: sourceFor(failure, { allowedPaths: ['src/a.js', 'src/b.js'] }),
    environment: ENV,
  });
  assert.equal(declared.ok, true, declared.code);
  assert.deepEqual(declared.evidence.allowedPaths, ['src/a.js', 'src/b.js']);
});

test('a failed outcome is a negative example, and a conflicting one needs review', () => {
  const failure = verifiedFailure();
  const negative = resolveLearningSource({
    failure, source: sourceFor(failure, { outcomeStatus: 'failed' }), environment: ENV,
  });
  assert.equal(negative.ok, true);
  assert.equal(negative.eligibility, ELIGIBILITY.NEGATIVE_EXAMPLE);

  const conflicting = resolveLearningSource({
    failure, source: sourceFor(failure, { verificationConflicting: true }), environment: ENV,
  });
  assert.equal(conflicting.ok, true);
  assert.equal(conflicting.eligibility, ELIGIBILITY.NEEDS_REVIEW);
});

test('attaching evidence adds the test contract the synthesis arms require', () => {
  const failure = verifiedFailure();
  const produced = produceTask(failure);
  assert.equal(produced.status, PRODUCER_STATUSES.TASK_PRODUCED);
  assert.equal(produced.task.test, undefined, 'the producer alone never invents a test');

  const resolved = resolveLearningSource({ failure, source: sourceFor(failure), environment: ENV });
  const attached = attachLearningSource(produced.task, resolved);
  assert.equal(attached.ok, true);
  assert.equal(attached.attached, true);
  assert.equal(attached.task.test.command, COMMAND);
  assert.equal(attached.task.learningSource.eligibility, ELIGIBILITY.POSITIVE_PROCEDURE);
  assert.equal(attached.task.learningSource.sourceHash, resolved.evidence.sourceHash);
  // The input task is untouched: attachment returns a new task.
  assert.equal(produced.task.test, undefined);
});

test('a needs-review resolution attaches no test, so nothing silently learns', () => {
  const failure = verifiedFailure();
  const produced = produceTask(failure);
  const resolved = resolveLearningSource({
    failure, source: sourceFor(failure, { verificationConflicting: true }), environment: ENV,
  });
  const attached = attachLearningSource(produced.task, resolved);
  assert.equal(attached.ok, true);
  assert.equal(attached.attached, false);
  assert.equal(attached.task.test, undefined);
});

function realRoot() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-4599-')));
  const git = (...args) => spawnSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-qb', 'feat/learning-source');
  git('config', 'user.email', 'ls@example.invalid');
  git('config', 'user.name', 'ls');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'version.md'), 'version v1.0.0\n', 'utf8');
  git('add', '.');
  git('commit', '-qm', 'base');
  return root;
}

function propose(root, failureFile, extraArgs = [], env = {}) {
  const child = spawnSync(process.execPath,
    [CLI, 'coder', 'propose', failureFile, '--json', ...extraArgs], {
      cwd: root, encoding: 'utf8', timeout: 120000,
      env: {
        ...process.env,
        HUQAN_STATE_ROOT: path.join(root, '.huqan', 'runtime-state'),
        [ACCEPTANCE_ENV.CHANNEL]: '',
        [ACCEPTANCE_ENV.COMMAND]: '',
        ...env,
      },
    });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr,
    json: child.stdout ? JSON.parse(child.stdout) : null };
}

test('the real CLI keeps a task without --source exactly as the producer made it', () => {
  const root = realRoot();
  try {
    const failure = verifiedFailure();
    const failureFile = path.join(root, 'failure.json');
    fs.writeFileSync(failureFile, JSON.stringify(failure), 'utf8');

    const plain = propose(root, failureFile);
    assert.equal(plain.status, 0);
    assert.equal(plain.json.data.task.test, undefined);
    assert.equal(plain.json.data.learningEligibility, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the real CLI attaches the oracle when an independent channel supplies it', () => {
  const root = realRoot();
  try {
    const failure = verifiedFailure();
    const failureFile = path.join(root, 'failure.json');
    const sourceFile = path.join(root, 'source.json');
    fs.writeFileSync(failureFile, JSON.stringify(failure), 'utf8');
    fs.writeFileSync(sourceFile, JSON.stringify(sourceFor(failure)), 'utf8');

    const withSource = propose(root, failureFile, ['--source', sourceFile], ENV);
    assert.equal(withSource.status, 0, JSON.stringify(withSource.json));
    assert.equal(withSource.json.data.learningEligibility, ELIGIBILITY.POSITIVE_PROCEDURE);
    assert.equal(withSource.json.data.task.test.command, COMMAND);
    assert.equal(withSource.json.data.task.learningSource.sourceHash, sealedFailureHash(failure));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the real CLI refuses a source file that claims its own independence', () => {
  const root = realRoot();
  try {
    const failure = verifiedFailure();
    const failureFile = path.join(root, 'failure.json');
    const sourceFile = path.join(root, 'source.json');
    fs.writeFileSync(failureFile, JSON.stringify(failure), 'utf8');
    // An agent-written file declaring `ci` is exactly the attack: no channel.
    fs.writeFileSync(sourceFile, JSON.stringify(
      sourceFor(failure, { oracle: { command: COMMAND, suppliedBy: 'ci' } })), 'utf8');

    const refused = propose(root, failureFile, ['--source', sourceFile]);
    assert.equal(refused.json.data.status, PRODUCER_STATUSES.NEEDS_HUMAN_DECISION);
    assert.equal(refused.json.data.reason, CODES.ORACLE_SUPPLY_UNVERIFIED);
    assert.equal(refused.json.data.task, null);
    assert.notEqual(refused.status, 0);
    // Nothing was written to the declared path.
    assert.equal(fs.readFileSync(path.join(root, 'docs', 'version.md'), 'utf8'), 'version v1.0.0\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the real CLI escalates a conflicting outcome instead of printing a task', () => {
  const root = realRoot();
  try {
    const failure = verifiedFailure();
    const failureFile = path.join(root, 'failure.json');
    const sourceFile = path.join(root, 'source.json');
    fs.writeFileSync(failureFile, JSON.stringify(failure), 'utf8');
    fs.writeFileSync(sourceFile, JSON.stringify(
      sourceFor(failure, { verificationConflicting: true })), 'utf8');

    const conflicted = propose(root, failureFile, ['--source', sourceFile], ENV);
    assert.equal(conflicted.json.data.status, PRODUCER_STATUSES.NEEDS_HUMAN_DECISION);
    assert.equal(conflicted.json.data.reason, CODES.OUTCOME_CONFLICTING);
    assert.equal(conflicted.json.data.task, null, 'a conflicting record must not print a task');
    assert.notEqual(conflicted.status, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a flag that names a file must name one', () => {
  const root = realRoot();
  try {
    const failure = verifiedFailure();
    const failureFile = path.join(root, 'failure.json');
    fs.writeFileSync(failureFile, JSON.stringify(failure), 'utf8');

    for (const tokens of [['--source'], ['--source', '--json'], ['--root']]) {
      const run = spawnSync(process.execPath, [CLI, 'coder', 'propose', failureFile, ...tokens], {
        cwd: root, encoding: 'utf8', timeout: 120000,
      });
      assert.notEqual(run.status, 0, `${tokens.join(' ')} must fail closed`);
      assert.match(run.stderr + run.stdout, /needs a file path/u);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

'use strict';

/**
 * #4599 — a verified failure may only become a learning-eligible task when an
 * independent acceptance oracle is present. These tests use the real producer,
 * the real contract and the real CLI; nothing here stubs the decision.
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
  CODES, ELIGIBILITY, sealedFailureHash, resolveLearningSource, attachLearningSource,
} = require('../lib/experience/learning-source');
const { LEARNING_ELIGIBILITY } = require('../lib/experience/contract');

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

const ORACLE = { command: 'node --test test/version.test.js', suppliedBy: 'ci', verifiedBy: 'ci' };

function sourceFor(failure, overrides = {}) {
  return {
    hash: sealedFailureHash(failure),
    outcomeStatus: 'verified',
    allowedPaths: ['docs/version.md'],
    oracle: { ...ORACLE },
    ...overrides,
  };
}

test('the eligibility vocabulary is the journal contract\'s, not a private copy', () => {
  // canary.js and capability-trust.js compare against the contract's exact
  // strings; a private spelling would publish a value nothing downstream reads.
  assert.deepEqual(ELIGIBILITY, LEARNING_ELIGIBILITY);
  assert.equal(ELIGIBILITY.INELIGIBLE, 'ineligible');
  const failure = verifiedFailure();
  const refused = resolveLearningSource({ failure, source: sourceFor(failure, { hash: 'b'.repeat(64) }) });
  assert.equal(refused.eligibility, LEARNING_ELIGIBILITY.INELIGIBLE);
});

test('a verified failure with an independent oracle resolves as a positive procedure', () => {
  const failure = verifiedFailure();
  const resolved = resolveLearningSource({ failure, source: sourceFor(failure) });
  assert.equal(resolved.ok, true, resolved.code);
  assert.equal(resolved.eligibility, ELIGIBILITY.POSITIVE_PROCEDURE);
  assert.equal(resolved.test.command, ORACLE.command);
  assert.match(resolved.evidence.sourceHash, /^[a-f0-9]{64}$/u);
  assert.equal(resolved.evidence.oracle.suppliedBy, 'ci');
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

test('an oracle HUQAN supplies for itself is refused, so a repair cannot grade itself', () => {
  const failure = verifiedFailure();
  for (const suppliedBy of ['huqan', 'agent', 'model', 'openhands', '']) {
    const resolved = resolveLearningSource({
      failure, source: sourceFor(failure, { oracle: { ...ORACLE, suppliedBy } }),
    });
    assert.equal(resolved.ok, false, `suppliedBy "${suppliedBy}" must be refused`);
    assert.equal(resolved.code, CODES.ORACLE_NOT_INDEPENDENT);
  }
});

test('a missing oracle, a hash mismatch and an unverified failure all fail closed', () => {
  const failure = verifiedFailure();
  const noOracle = resolveLearningSource({ failure, source: sourceFor(failure, { oracle: undefined }) });
  assert.equal(noOracle.code, CODES.ORACLE_MISSING);

  const blankCommand = resolveLearningSource({
    failure, source: sourceFor(failure, { oracle: { ...ORACLE, command: '   ' } }),
  });
  assert.equal(blankCommand.code, CODES.ORACLE_MISSING);

  const wrongHash = resolveLearningSource({ failure, source: sourceFor(failure, { hash: 'a'.repeat(64) }) });
  assert.equal(wrongHash.code, CODES.SOURCE_HASH_MISMATCH);

  const unverified = resolveLearningSource({
    failure: { ...failure, verificationStatus: 'candidate' }, source: sourceFor(failure),
  });
  assert.equal(unverified.code, CODES.FAILURE_NOT_VERIFIED);
});

test('a path outside the declared allowed paths is refused', () => {
  const failure = verifiedFailure();
  const escaped = resolveLearningSource({
    failure, source: sourceFor(failure, { allowedPaths: ['src/other.js'] }),
  });
  assert.equal(escaped.code, CODES.PATH_NOT_ALLOWED);

  const absolute = resolveLearningSource({
    failure, source: sourceFor(failure, { allowedPaths: ['/etc/passwd'] }),
  });
  assert.equal(absolute.code, CODES.ALLOWED_PATHS_INVALID);
});

test('a failed outcome is a negative example, and a conflicting one needs review', () => {
  const failure = verifiedFailure();
  const negative = resolveLearningSource({
    failure, source: sourceFor(failure, { outcomeStatus: 'failed' }),
  });
  assert.equal(negative.ok, true);
  assert.equal(negative.eligibility, ELIGIBILITY.NEGATIVE_EXAMPLE);

  const conflicting = resolveLearningSource({
    failure, source: sourceFor(failure, { verificationConflicting: true }),
  });
  assert.equal(conflicting.ok, true);
  assert.equal(conflicting.eligibility, ELIGIBILITY.NEEDS_REVIEW);
});

test('attaching evidence adds the test contract the synthesis arms require', () => {
  const failure = verifiedFailure();
  const produced = produceTask(failure);
  assert.equal(produced.status, PRODUCER_STATUSES.TASK_PRODUCED);
  assert.equal(produced.task.test, undefined, 'the producer alone never invents a test');

  const resolved = resolveLearningSource({ failure, source: sourceFor(failure) });
  const attached = attachLearningSource(produced.task, resolved);
  assert.equal(attached.ok, true);
  assert.equal(attached.attached, true);
  assert.equal(attached.task.test.command, ORACLE.command);
  assert.equal(attached.task.learningSource.eligibility, ELIGIBILITY.POSITIVE_PROCEDURE);
  assert.equal(attached.task.learningSource.sourceHash, resolved.evidence.sourceHash);
  // The input task is untouched: attachment returns a new task.
  assert.equal(produced.task.test, undefined);
});

test('a needs-review resolution attaches no test, so nothing silently learns', () => {
  const failure = verifiedFailure();
  const produced = produceTask(failure);
  const resolved = resolveLearningSource({
    failure, source: sourceFor(failure, { verificationConflicting: true }),
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

function propose(root, failureFile, extraArgs = []) {
  const child = spawnSync(process.execPath,
    [CLI, 'coder', 'propose', failureFile, '--json', ...extraArgs], {
      cwd: root, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, HUQAN_STATE_ROOT: path.join(root, '.huqan', 'runtime-state') },
    });
  return { status: child.status, json: child.stdout ? JSON.parse(child.stdout) : null };
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

test('the real CLI attaches the oracle when an independent source is declared', () => {
  const root = realRoot();
  try {
    const failure = verifiedFailure();
    const failureFile = path.join(root, 'failure.json');
    const sourceFile = path.join(root, 'source.json');
    fs.writeFileSync(failureFile, JSON.stringify(failure), 'utf8');
    fs.writeFileSync(sourceFile, JSON.stringify(sourceFor(failure)), 'utf8');

    const withSource = propose(root, failureFile, ['--source', sourceFile]);
    assert.equal(withSource.status, 0, JSON.stringify(withSource.json));
    assert.equal(withSource.json.data.learningEligibility, ELIGIBILITY.POSITIVE_PROCEDURE);
    assert.equal(withSource.json.data.task.test.command, ORACLE.command);
    assert.equal(withSource.json.data.task.learningSource.sourceHash, sealedFailureHash(failure));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the real CLI refuses a self-supplied oracle instead of producing a task', () => {
  const root = realRoot();
  try {
    const failure = verifiedFailure();
    const failureFile = path.join(root, 'failure.json');
    const sourceFile = path.join(root, 'source.json');
    fs.writeFileSync(failureFile, JSON.stringify(failure), 'utf8');
    fs.writeFileSync(sourceFile, JSON.stringify(
      sourceFor(failure, { oracle: { ...ORACLE, suppliedBy: 'huqan' } })), 'utf8');

    const refused = propose(root, failureFile, ['--source', sourceFile]);
    assert.equal(refused.json.data.status, PRODUCER_STATUSES.NEEDS_HUMAN_DECISION);
    assert.equal(refused.json.data.reason, CODES.ORACLE_NOT_INDEPENDENT);
    assert.equal(refused.json.data.task, null);
    assert.notEqual(refused.status, 0);
    // Nothing was written to the declared path.
    assert.equal(fs.readFileSync(path.join(root, 'docs', 'version.md'), 'utf8'), 'version v1.0.0\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

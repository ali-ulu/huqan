'use strict';

/**
 * #4599 / #4624 — a verified failure may only become a learning-eligible task
 * when an independent acceptance oracle is present. These tests use the real
 * producer, the real contract and the real CLI; nothing here stubs the decision.
 *
 * #4624 widened the original finding. Independence cannot come from a label in
 * the source file (`--source` reads a caller-selected file) and it cannot come
 * from an environment variable either: the proposing agent launches its own
 * process and writes its own environment. It comes from a decision envelope the
 * approval authority signed over the exact source hash, command and path set.
 * These tests mint those envelopes with a local keypair, mount the matching
 * pinned key, and show that every other route -- including a self-signed one --
 * refuses.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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
const {
  ATTESTATION_TOOL, acceptanceActionHash, allowedPathsHash,
} = require('../lib/experience/acceptance-attestation');
const { signDecision, DECISION_VERSION } = require('../lib/authority/decision-envelope');
const { LEARNING_ELIGIBILITY } = require('../lib/experience/contract');

// The pinned authority the runtime would have installed. Tests mint with the
// matching private key and pass the public one as `trustedKey`.
const AUTHORITY = crypto.generateKeyPairSync('ed25519');
const NOW = Date.now();
const at = (offsetMs) => new Date(NOW + offsetMs).toISOString();

/**
 * A signed acceptance attestation for exactly this evidence, as the approval
 * authority would mint it. Defaults cover the standard fixture; overrides let a
 * test sign *different* evidence to prove the binding refuses it.
 */
function attestationFor(failure, {
  command = COMMAND, allowedPaths = ['docs/version.md'], channel = SUPPLY_CHANNELS.CI,
  sourceHash = sealedFailureHash(failure), key = AUTHORITY.privateKey, approvalId = 'acceptance-1',
  workspaceId = 'default', decidedAt = at(-60_000), validUntil = at(9 * 60_000),
} = {}) {
  const actionHash = acceptanceActionHash({
    sourceHash,
    commandHash: crypto.createHash('sha256').update(command, 'utf8').digest('hex'),
    allowedPathsHash: allowedPathsHash(allowedPaths),
    channel,
    approvalId,
    workspaceId,
  });
  assert.ok(actionHash, 'the fixture evidence must be hashable');
  const envelope = signDecision({
    v: DECISION_VERSION, approvalId, workspaceId, tool: ATTESTATION_TOOL, actionHash,
    decision: 'approved', reason: '', decidedAt, validUntil, ledgerSeq: 3,
    ledgerHash: 'b'.repeat(64), operator: 'totp:primary',
  }, key);
  return { channel, envelope };
}

const TRUSTED = AUTHORITY.publicKey;
/**
 * Resolve a learning source whose oracle the authority attested for exactly the
 * evidence the source declares. The common path in these tests: anything that
 * should be refused for a reason *other* than the oracle must not first trip
 * the oracle check, so it gets a valid attestation and the real subject of the
 * test is what refuses.
 */
function resolve(failure, source = sourceFor(failure), extra = {}) {
  const allowedPaths = Array.isArray(source.allowedPaths) ? source.allowedPaths : ['docs/version.md'];
  const command = source.oracle && typeof source.oracle.command === 'string' ? source.oracle.command : COMMAND;
  return resolveLearningSource({
    failure,
    source,
    attestation: attestationFor(failure, { command, allowedPaths }),
    trustedKey: TRUSTED,
    now: NOW,
    ...extra,
  });
}

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
  const refused = resolve(failure, sourceFor(failure, { hash: 'b'.repeat(64) }));
  assert.equal(refused.eligibility, LEARNING_ELIGIBILITY.INELIGIBLE);
});

test('a verified failure with an independent oracle resolves as a positive procedure', () => {
  const failure = verifiedFailure();
  const resolved = resolve(failure);
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

test('oracle independence comes from a signer the proposing agent cannot impersonate', () => {
  const failure = verifiedFailure();
  const source = sourceFor(failure);

  // No attestation: a label in the source file, and a launcher-set environment
  // variable, both prove nothing.
  const unverified = resolveLearningSource({ failure, source, trustedKey: TRUSTED, now: NOW });
  assert.equal(unverified.ok, false);
  assert.equal(unverified.code, CODES.ORACLE_SUPPLY_UNVERIFIED);

  // The file admits where it came from; that is still not independence, and it
  // is refused before any signature is even considered.
  const fromFile = resolveLearningSource({
    failure, source: sourceFor(failure, { oracle: { command: COMMAND, suppliedBy: SUPPLY_CHANNELS.SOURCE_FILE } }),
    attestation: attestationFor(failure, { channel: SUPPLY_CHANNELS.SOURCE_FILE }),
    trustedKey: TRUSTED, now: NOW,
  });
  assert.equal(fromFile.code, CODES.ORACLE_NOT_INDEPENDENT);

  // A self-declared supplier in the file cannot agree its way into eligibility.
  const selfDeclared = resolveLearningSource({
    failure,
    source: sourceFor(failure, { oracle: { command: COMMAND, suppliedBy: 'huqan' } }),
    attestation: attestationFor(failure),
    trustedKey: TRUSTED, now: NOW,
  });
  assert.equal(selfDeclared.code, CODES.ORACLE_SUPPLY_UNVERIFIED);

  // A decision signed by some other key is a forgery, not an attestation. The
  // envelope names the foreign key's id, so verification stops at key_mismatch
  // before the signature is even checked -- either way it never verifies.
  const forged = resolveLearningSource({
    failure, source,
    attestation: attestationFor(failure, { key: crypto.generateKeyPairSync('ed25519').privateKey }),
    trustedKey: TRUSTED, now: NOW,
  });
  assert.equal(forged.code, CODES.ORACLE_SUPPLY_UNVERIFIED);
  assert.equal(forged.detail, 'key_mismatch');

  // No pinned key at all: with no trust anchor nobody can be shown to have
  // signed, so independence is unavailable rather than assumed.
  const noAnchor = resolveLearningSource({ failure, source, attestation: attestationFor(failure), now: NOW });
  assert.equal(noAnchor.code, CODES.ORACLE_SUPPLY_UNVERIFIED);
});

test('a self-declared channel variable grants nothing, which is the #4624 finding', () => {
  const failure = verifiedFailure();
  const source = sourceFor(failure);

  // The attack, verbatim: an agent that controls its own launcher sets the
  // channel it wishes it had. The resolver never reads it, so the outcome is
  // identical to setting nothing at all.
  const baseline = resolveLearningSource({ failure, source, trustedKey: TRUSTED, now: NOW });
  for (const value of ['ci', 'operator', 'CI', 'source-file']) {
    const claimed = resolveLearningSource({
      failure, source, trustedKey: TRUSTED, now: NOW,
      environment: {
        HUQAN_ACCEPTANCE_CHANNEL: value,
        HUQAN_ACCEPTANCE_COMMAND: COMMAND,
      },
    });
    assert.equal(claimed.code, CODES.ORACLE_SUPPLY_UNVERIFIED, `channel "${value}" must not be believed`);
    assert.deepEqual(claimed, baseline, 'the environment must not change the outcome at all');
  }

  // `source.oracle.suppliedBy` is the same self-declaration in file form, and is
  // refused for the same reason.
  const inFile = resolveLearningSource({
    failure, source: sourceFor(failure, { oracle: { command: COMMAND, suppliedBy: 'operator' } }),
    trustedKey: TRUSTED, now: NOW,
  });
  assert.equal(inFile.code, CODES.ORACLE_SUPPLY_UNVERIFIED);
});

test('the attestation file location is not itself evidence', () => {
  const failure = verifiedFailure();
  const source = sourceFor(failure);

  // Pointing the variable at an unsigned file changes nothing: the verifier is
  // handed `null` by the CLI and refuses, and the module never treats a path as
  // a grant.
  const pointed = resolveLearningSource({
    failure, source, trustedKey: TRUSTED, now: NOW,
    environment: { HUQAN_ACCEPTANCE_ATTESTATION: '/tmp/whatever.json' },
  });
  assert.equal(pointed.code, CODES.ORACLE_SUPPLY_UNVERIFIED);
});

test('an attestation binds one failure, one command and one path set', () => {
  const failure = verifiedFailure();

  // Signed for a different failure record.
  const otherFailure = resolveLearningSource({
    failure, source: sourceFor(failure),
    attestation: attestationFor(failure, { sourceHash: 'a'.repeat(64) }),
    trustedKey: TRUSTED, now: NOW,
  });
  assert.equal(otherFailure.code, CODES.ORACLE_SUPPLY_UNVERIFIED);
  assert.equal(otherFailure.detail, 'binding_mismatch');

  // Signed for a different acceptance command.
  const otherCommand = resolveLearningSource({
    failure, source: sourceFor(failure),
    attestation: attestationFor(failure, { command: 'node --test test/other.test.js' }),
    trustedKey: TRUSTED, now: NOW,
  });
  assert.equal(otherCommand.code, CODES.ORACLE_SUPPLY_UNVERIFIED);

  // Signed for a narrower path set than the source declares: widening the
  // declaration after the fact must not inherit the grant.
  const otherPaths = resolveLearningSource({
    failure, source: sourceFor(failure, { allowedPaths: ['docs/version.md', 'docs/other.md'] }),
    attestation: attestationFor(failure, { allowedPaths: ['docs/version.md'] }),
    trustedKey: TRUSTED, now: NOW,
  });
  assert.equal(otherPaths.code, CODES.ORACLE_SUPPLY_UNVERIFIED);

  // Expired: the operator's grant ran out, and the refusal says so.
  const expired = resolveLearningSource({
    failure, source: sourceFor(failure),
    attestation: attestationFor(failure, { decidedAt: at(-9 * 60_000), validUntil: at(-8 * 60_000) }),
    trustedKey: TRUSTED, now: NOW,
  });
  assert.equal(expired.code, CODES.ORACLE_SUPPLY_UNVERIFIED);
  assert.equal(expired.detail, 'expired');

  // The same evidence, correctly signed, is accepted -- so the refusals above
  // are the binding and not a broken fixture.
  const accepted = resolveLearningSource({
    failure, source: sourceFor(failure), attestation: attestationFor(failure), trustedKey: TRUSTED, now: NOW,
  });
  assert.equal(accepted.ok, true, accepted.code);
  assert.equal(accepted.evidence.oracle.channel, SUPPLY_CHANNELS.CI);
  assert.equal(accepted.evidence.oracle.approvalId, 'acceptance-1');
});

test('a missing oracle, a hash mismatch and an unverified failure all fail closed', () => {
  const failure = verifiedFailure();
  const noOracle = resolve(failure, sourceFor(failure, { oracle: undefined }));
  assert.equal(noOracle.code, CODES.ORACLE_MISSING);

  const blankCommand = resolve(failure, sourceFor(failure, { oracle: { command: '   ' } }));
  assert.equal(blankCommand.code, CODES.ORACLE_MISSING);

  const wrongHash = resolve(failure, sourceFor(failure, { hash: 'a'.repeat(64) }));
  assert.equal(wrongHash.code, CODES.SOURCE_HASH_MISMATCH);

  const unverified = resolve({ ...failure, verificationStatus: 'candidate' });
  assert.equal(unverified.code, CODES.FAILURE_NOT_VERIFIED);
});

test('a path outside the declared allowed paths is refused', () => {
  const failure = verifiedFailure();
  const escaped = resolve(failure, sourceFor(failure, { allowedPaths: ['src/other.js'] }));
  assert.equal(escaped.code, CODES.PATH_NOT_ALLOWED);

  const absolute = resolve(failure, sourceFor(failure, { allowedPaths: ['/etc/passwd'] }));
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

  const undeclared = resolve(failure, sourceFor(failure, { allowedPaths: ['src/a.js'] }));
  assert.equal(undeclared.code, CODES.PATH_NOT_ALLOWED);

  const declared = resolve(failure, sourceFor(failure, { allowedPaths: ['src/a.js', 'src/b.js'] }));
  assert.equal(declared.ok, true, declared.code);
  assert.deepEqual(declared.evidence.allowedPaths, ['src/a.js', 'src/b.js']);
});

test('a failed outcome is a negative example, and a conflicting one needs review', () => {
  const failure = verifiedFailure();
  const negative = resolve(failure, sourceFor(failure, { outcomeStatus: 'failed' }));
  assert.equal(negative.ok, true);
  assert.equal(negative.eligibility, ELIGIBILITY.NEGATIVE_EXAMPLE);

  const conflicting = resolve(failure, sourceFor(failure, { verificationConflicting: true }));
  assert.equal(conflicting.ok, true);
  assert.equal(conflicting.eligibility, ELIGIBILITY.NEEDS_REVIEW);
});

test('attaching evidence adds the test contract the synthesis arms require', () => {
  const failure = verifiedFailure();
  const produced = produceTask(failure);
  assert.equal(produced.status, PRODUCER_STATUSES.TASK_PRODUCED);
  assert.equal(produced.task.test, undefined, 'the producer alone never invents a test');

  const resolved = resolve(failure);
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
  const resolved = resolve(failure, sourceFor(failure, { verificationConflicting: true }));
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

/**
 * Run the real CLI in a real repository.
 *
 * The child resolves the trust anchor itself, from the installed authority pin,
 * so a test cannot inject a key here without becoming the backdoor this issue
 * removes. That is why the CLI cases below assert refusals: they are the
 * behaviour a proposer meets, and `resolve()` above covers the accepting path
 * with a mounted key.
 */
function propose(root, failureFile, extraArgs = [], env = {}) {
  const child = spawnSync(process.execPath,
    [CLI, 'coder', 'propose', failureFile, '--json', ...extraArgs], {
      cwd: root, encoding: 'utf8', timeout: 120000,
      env: {
        ...process.env,
        HUQAN_STATE_ROOT: path.join(root, '.huqan', 'runtime-state'),
        [ACCEPTANCE_ENV.ATTESTATION]: '',
        ...env,
      },
    });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr,
    json: child.stdout ? JSON.parse(child.stdout) : null };
}

/** Write a signed attestation the way an operator would hand one over. */
function writeAttestation(root, failure, overrides = {}) {
  const file = path.join(root, 'attestation.json');
  fs.writeFileSync(file, JSON.stringify(attestationFor(failure, overrides)), 'utf8');
  return file;
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

test('the real CLI refuses an oracle when no OS-boundary authority is installed', () => {
  const root = realRoot();
  try {
    const failure = verifiedFailure();
    const failureFile = path.join(root, 'failure.json');
    const sourceFile = path.join(root, 'source.json');
    fs.writeFileSync(failureFile, JSON.stringify(failure), 'utf8');
    fs.writeFileSync(sourceFile, JSON.stringify(sourceFor(failure)), 'utf8');

    // A perfectly signed attestation, handed over through the documented
    // variable. It is still refused, because this runtime has no installed
    // authority pin to verify it against -- and a key the proposer could
    // choose is not a trust anchor. Independence is unavailable here, and
    // saying so is the correct answer.
    const attestationFile = writeAttestation(root, failure);
    const refused = propose(root, failureFile, ['--source', sourceFile],
      { [ACCEPTANCE_ENV.ATTESTATION]: attestationFile });
    assert.equal(refused.json.data.status, PRODUCER_STATUSES.NEEDS_HUMAN_DECISION);
    assert.equal(refused.json.data.reason, CODES.ORACLE_SUPPLY_UNVERIFIED);
    assert.equal(refused.json.data.task, null);
    assert.notEqual(refused.status, 0);
    assert.equal(fs.readFileSync(path.join(root, 'docs', 'version.md'), 'utf8'), 'version v1.0.0\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the real CLI refuses an unsigned attestation file as if there were none', () => {
  const root = realRoot();
  try {
    const failure = verifiedFailure();
    const failureFile = path.join(root, 'failure.json');
    const sourceFile = path.join(root, 'source.json');
    const bogus = path.join(root, 'attestation.json');
    fs.writeFileSync(failureFile, JSON.stringify(failure), 'utf8');
    fs.writeFileSync(sourceFile, JSON.stringify(sourceFor(failure)), 'utf8');
    // The attack: the agent writes its own "attestation" and points the
    // variable at it. Nothing about the file is signed by anyone.
    fs.writeFileSync(bogus, JSON.stringify({ channel: 'ci', envelope: { alg: 'Ed25519' } }), 'utf8');

    const refused = propose(root, failureFile, ['--source', sourceFile],
      { [ACCEPTANCE_ENV.ATTESTATION]: bogus });
    assert.equal(refused.json.data.reason, CODES.ORACLE_SUPPLY_UNVERIFIED);
    assert.equal(refused.json.data.task, null);
    assert.notEqual(refused.status, 0);

    // A file that is not even JSON is the same refusal, not a crash.
    fs.writeFileSync(bogus, 'not json at all', 'utf8');
    const garbage = propose(root, failureFile, ['--source', sourceFile],
      { [ACCEPTANCE_ENV.ATTESTATION]: bogus });
    assert.equal(garbage.json.data.reason, CODES.ORACLE_SUPPLY_UNVERIFIED);
    assert.notEqual(garbage.status, 0);
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

    // Without a trust anchor the oracle check refuses first: an unattested
    // record never reaches the conflicting-outcome branch, so nothing is
    // escalated as if it had been verified.
    const conflicted = propose(root, failureFile, ['--source', sourceFile], {
      [ACCEPTANCE_ENV.ATTESTATION]: writeAttestation(root, failure),
    });
    assert.equal(conflicted.json.data.status, PRODUCER_STATUSES.NEEDS_HUMAN_DECISION);
    assert.equal(conflicted.json.data.reason, CODES.ORACLE_SUPPLY_UNVERIFIED);
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

test('a grant is scoped to the workspace the failure came from', () => {
  // #4624: the workspace must be resolved from the failure record, not from the
  // envelope, or the check compares the envelope with itself and an approval
  // for workspace A covers a failure from workspace B.
  const failure = verifiedFailure();
  assert.equal(failure.workspaceId, 'default', 'the producer records the workspace');

  // A grant minted for another workspace cannot attach learning eligibility.
  const otherWorkspace = attestationFor(failure, { workspaceId: 'other' });
  const refused = resolveLearningSource({
    failure, source: sourceFor(failure), attestation: otherWorkspace, trustedKey: TRUSTED, now: NOW,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, CODES.ORACLE_SUPPLY_UNVERIFIED);

  // The failure's workspace is inside the sealed hash, so relabelling the
  // record invalidates the hash the source declares rather than silently
  // moving the grant to another workspace.
  const relabelled = { ...failure, workspaceId: 'other' };
  assert.notEqual(sealedFailureHash(relabelled), sealedFailureHash(failure));

  // An explicitly declared workspace that disagrees with the record is refused
  // outright: two disagreeing declarations are ambiguous evidence.
  const mismatched = resolve(failure, sourceFor(failure), { workspaceId: 'other' });
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.code, CODES.WORKSPACE_MISMATCH);

  // A failure with no workspace at all has no grant to attach.
  const { workspaceId: _omitted, ...anonymous } = failure;
  const missing = resolveLearningSource({
    failure: anonymous, source: sourceFor(failure), attestation: attestationFor(failure),
    trustedKey: TRUSTED, now: NOW,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, CODES.WORKSPACE_MISSING);
});

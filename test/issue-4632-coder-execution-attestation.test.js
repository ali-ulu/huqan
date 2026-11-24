'use strict';

/**
 * #4632 — a signed acceptance oracle must still be the oracle at execution.
 *
 * `coder propose --source` verifies the Authority's attestation and prints a
 * task file. That file is editable before `coder <task.json>` runs, so the
 * execution boundary re-verifies the attestation and binds it to the facts it
 * is about to use: the test command, the allowlist, the failure source hash,
 * the workspace, the approval id and the action hash.
 *
 * The positive control runs the unmodified task and proves the exact signed
 * evidence reaches the journal. Every negative control edits one bound fact,
 * runs the same public handler, and asserts three things: the run is refused,
 * the working tree keeps its bytes, and the journal holds no run at all (so
 * nothing can be admitted as a learning candidate later).
 *
 * Boundary note: a child process cannot be handed an OS-boundary pin, so the
 * accepting and editing cases drive the real `coder` handler in-process through
 * the same `authorityMode` seam the CLI fills from the installed pin. The
 * child-process control at the end proves the other half: with no installed
 * pin, the real `cli.js` refuses the same task and writes nothing.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');

const CLI = path.resolve(__dirname, '..', 'cli.js');
const MemoryStore = require('../lib/memory-store');
const { createErrorPrevention } = require('../lib/error-prevention');
const { PRODUCER_STATUSES } = require('../lib/task-producer');
const { runCliCoderPropose } = require('../lib/cli-coder-propose');
const { runCliCoder } = require('../lib/cli-coder');
const { runFixLoop, formatLoopText } = require('../lib/coder/fix-loop');
const { openCoderJournal } = require('../lib/coder/journal-store');
const { verifyExecutionLearningSource } = require('../lib/experience/coder-execution-attestation');
const {
  CODES: SOURCE_CODES, ELIGIBILITY, sealedFailureHash, ACCEPTANCE_ENV,
} = require('../lib/experience/learning-source');
const {
  ATTESTATION_TOOL, acceptanceActionHash, allowedPathsHash,
} = require('../lib/experience/acceptance-attestation');
const { signDecision, DECISION_VERSION } = require('../lib/authority/decision-envelope');

const COMMAND = 'node acceptance.test.js';
const OTHER_COMMAND = 'node other.test.js';
const BASE = 'version v1.0.0\n';
const FIXED = 'version v1.1.0\n';
const WORKSPACE = 'default';

const AUTHORITY = crypto.generateKeyPairSync('ed25519');
const OTHER_KEY = crypto.generateKeyPairSync('ed25519');
const NOW = Date.now();
const at = (offsetMs) => new Date(NOW + offsetMs).toISOString();
const TRUSTED_MODE = Object.freeze({
  mode: 'service', boundary: 'os-service', pin: Object.freeze({ signingKey: AUTHORITY.publicKey }),
});
const NO_AUTHORITY = Object.freeze({ mode: 'legacy', boundary: 'same-user' });

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function acceptanceFor(file) {
  return `require('node:assert/strict').equal(require('node:fs').readFileSync(${JSON.stringify(file)}, 'utf8'), ${JSON.stringify(FIXED)});\n`;
}

function repo(root) {
  fs.mkdirSync(root, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore', windowsHide: true });
  git('init', '-qb', 'feat/execution-attestation');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'user.name', 'fixture');
  git('config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'version.md'), BASE, 'utf8');
  fs.writeFileSync(path.join(root, 'docs', 'other.md'), BASE, 'utf8');
  fs.writeFileSync(path.join(root, 'acceptance.test.js'), acceptanceFor('docs/version.md'), 'utf8');
  fs.writeFileSync(path.join(root, 'other.test.js'), acceptanceFor('docs/other.md'), 'utf8');
  git('add', '-A');
  git('commit', '-qm', 'base');
}

function verifiedFailure() {
  const prevention = createErrorPrevention(new MemoryStore({ useSQLite: false }), {
    verifyEvidence: ({ source, evidence }) => source === 'test_failure'
      && evidence.some((item) => item?.type === 'test' && item?.verifiedBy === 'ci'),
  });
  const recorded = prevention.recordFailure({
    tool: 'coder', operation: 'replace_text', path: 'docs/version.md', workspaceId: WORKSPACE,
    source: 'test_failure', observed: 'v1.0.0', expected: 'v1.1.0',
    evidence: [{ type: 'test', verifiedBy: 'ci' }],
  });
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  return recorded.failure;
}

function attestationFor(failure, {
  command = COMMAND, allowedPaths = ['docs/version.md'], approvalId = 'acceptance-execution',
  validUntil = at(9 * 60_000), key = AUTHORITY.privateKey,
} = {}) {
  const actionHash = acceptanceActionHash({
    sourceHash: sealedFailureHash(failure),
    commandHash: sha256(command),
    allowedPathsHash: allowedPathsHash(allowedPaths),
    channel: 'ci',
    approvalId,
    workspaceId: WORKSPACE,
  });
  assert.ok(actionHash, 'the fixture evidence must be hashable');
  return {
    channel: 'ci',
    envelope: signDecision({
      v: DECISION_VERSION, approvalId, workspaceId: WORKSPACE, tool: ATTESTATION_TOOL, actionHash,
      decision: 'approved', reason: '', decidedAt: at(-60_000), validUntil, ledgerSeq: 3,
      ledgerHash: 'b'.repeat(64), operator: 'totp:primary',
    }, key),
  };
}

function sourceFor(failure) {
  return {
    hash: sealedFailureHash(failure),
    outcomeStatus: 'verified',
    allowedPaths: ['docs/version.md'],
    oracle: { command: COMMAND },
  };
}

/** Write the three files and run the real `coder propose` handler. */
function proposeTask(dir, { failure, attestation }) {
  const failureFile = path.join(dir, 'failure.json');
  const sourceFile = path.join(dir, 'source.json');
  const attestationFile = path.join(dir, 'attestation.json');
  fs.writeFileSync(failureFile, JSON.stringify(failure), 'utf8');
  fs.writeFileSync(sourceFile, JSON.stringify(sourceFor(failure)), 'utf8');
  fs.writeFileSync(attestationFile, JSON.stringify(attestation), 'utf8');
  const result = runCliCoderPropose([failureFile, '--source', sourceFile, '--json'], {
    json: true,
    environment: { [ACCEPTANCE_ENV.ATTESTATION]: attestationFile },
    authorityMode: TRUSTED_MODE,
    now: NOW,
  });
  assert.equal(result.data.status, PRODUCER_STATUSES.TASK_PRODUCED, JSON.stringify(result.data));
  return { task: result.data.task, attestationFile };
}

/**
 * Run the public `coder` handler for one task. `environment` names the
 * attestation file, or omits the variable entirely for the "missing" control.
 */
function runTask({ root, taskFile, runId, journalPath, environment = {}, authorityMode = TRUSTED_MODE }) {
  const result = runCliCoder([taskFile, '--root', root, '--json', '--authorize',
    '--journal', journalPath, '--run-id', runId], {
    json: true,
    coderLoop: { runFixLoop, formatLoopText, verifyExecutionLearningSource },
    authorityMode,
    environment,
    workspaceId: WORKSPACE,
    now: NOW,
  });
  return result;
}

function sealedEvents(journalPath, runId) {
  const store = openCoderJournal(journalPath);
  try {
    return { events: store.journal.read(runId), manifest: store.journal.manifest(runId) };
  } finally {
    store.close();
  }
}

test('#4632 an unchanged learning task keeps its signed evidence; every edited bound fact is refused before a write', async (t) => {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-4632-')));
  const root = path.join(fixture, 'repo');
  repo(root);
  const journalPath = path.join(fixture, 'evidence.db');
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

  const failure = verifiedFailure();
  const attestation = attestationFor(failure);
  const { task, attestationFile } = proposeTask(fixture, { failure, attestation });
  const sourceHash = sealedFailureHash(failure);
  assert.equal(task.learningSource.sourceHash, sourceHash);
  assert.equal(task.learningSource.oracle.actionHash, attestation.envelope.payload.actionHash);

  const write = (name, value) => {
    const file = path.join(fixture, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(value), 'utf8');
    return file;
  };
  const baseTaskFile = write('task', task);

  // Positive control: the untouched task runs, and the journal carries exactly
  // the evidence the Authority signed -- recomputable from the sealed fields.
  const accepted = runTask({ root, taskFile: baseTaskFile, runId: 'accepted',
    journalPath, environment: { [ACCEPTANCE_ENV.ATTESTATION]: attestationFile } });
  assert.equal(accepted.status, 'completed', JSON.stringify(accepted));
  assert.equal(accepted.data.outcome, 'applied_tested');
  assert.equal(fs.readFileSync(path.join(root, 'docs', 'version.md'), 'utf8'), FIXED);
  const sealed = sealedEvents(journalPath, 'accepted:c1');
  assert.equal(sealed.manifest.learningEligibility, ELIGIBILITY.POSITIVE_PROCEDURE);
  const sealedSource = sealed.events[0].payload.learningSource;
  assert.equal(sealedSource.sourceHash, sourceHash);
  assert.equal(sealedSource.oracle.commandHash, sha256(COMMAND));
  assert.equal(sealedSource.oracle.channel, 'ci');
  assert.equal(sealedSource.oracle.approvalId, attestation.envelope.payload.approvalId);
  assert.equal(acceptanceActionHash({
    sourceHash: sealedSource.sourceHash,
    commandHash: sealedSource.oracle.commandHash,
    allowedPathsHash: allowedPathsHash(sealedSource.allowedPaths),
    channel: sealedSource.oracle.channel,
    approvalId: sealedSource.oracle.approvalId,
    workspaceId: WORKSPACE,
  }), sealedSource.oracle.actionHash);

  // Negative controls: each edits one fact the signature binds. Every one must
  // refuse before a write and leave no journal run behind.
  const tampered = [
    ['swapped-command', (value) => { value.test.command = OTHER_COMMAND; }, 'command_hash_mismatch'],
    ['widened-allowlist', (value) => { value.allowedPaths = ['docs/version.md', 'docs/other.md']; },
      'allowed_paths_mismatch'],
    ['narrowed-source-copy', (value) => { value.learningSource.allowedPaths = ['docs/other.md']; },
      'allowed_paths_mismatch'],
    ['swapped-source-hash', (value) => { value.learningSource.sourceHash = 'a'.repeat(64); },
      'binding_mismatch'],
    ['swapped-approval-id', (value) => { value.learningSource.oracle.approvalId = 'another-approval'; },
      'approval_id_mismatch'],
    ['swapped-action-hash', (value) => { value.learningSource.oracle.actionHash = 'c'.repeat(64); },
      'action_hash_mismatch'],
    ['swapped-channel', (value) => { value.learningSource.oracle.channel = 'source-file'; },
      'channel_mismatch'],
    ['forged-eligibility', (value) => { value.learningSource.eligibility = 'needs_review'; },
      'eligibility'],
    ['dropped-outcome-hash', (value) => { delete value.learningSource.observedHash; }, 'outcome_hashes'],
  ];
  for (const [name, mutate, detail] of tampered) {
    fs.writeFileSync(path.join(root, 'docs', 'version.md'), BASE, 'utf8');
    const value = JSON.parse(fs.readFileSync(baseTaskFile, 'utf8'));
    mutate(value);
    const refused = runTask({ root, taskFile: write(name, value), runId: name, journalPath,
      environment: { [ACCEPTANCE_ENV.ATTESTATION]: attestationFile } });
    assert.equal(refused.status, 'refused', `${name}: ${JSON.stringify(refused)}`);
    assert.equal(refused.data.detail, detail, `${name}: ${JSON.stringify(refused)}`);
    assert.equal(fs.readFileSync(path.join(root, 'docs', 'version.md'), 'utf8'), BASE,
      `${name}: a refused task must not write`);
    assert.deepEqual(sealedEvents(journalPath, `${name}:c1`).events, [],
      `${name}: a refused task must seal no run`);
  }

  // A present-but-falsy `learningSource` is still a claim the task makes. It
  // must refuse, not read as "no learning evidence" and run unverified.
  for (const [name, falsy] of [['falsy-false', false], ['falsy-zero', 0], ['falsy-empty', '']]) {
    fs.writeFileSync(path.join(root, 'docs', 'version.md'), BASE, 'utf8');
    const value = JSON.parse(fs.readFileSync(baseTaskFile, 'utf8'));
    value.learningSource = falsy;
    const refused = runTask({ root, taskFile: write(name, value), runId: name, journalPath,
      environment: { [ACCEPTANCE_ENV.ATTESTATION]: attestationFile } });
    assert.equal(refused.status, 'refused', `${name}: ${JSON.stringify(refused)}`);
    assert.equal(refused.data.reason, SOURCE_CODES.INVALID_INPUT, `${name}: ${JSON.stringify(refused)}`);
    assert.equal(fs.readFileSync(path.join(root, 'docs', 'version.md'), 'utf8'), BASE,
      `${name}: a refused task must not write`);
    assert.deepEqual(sealedEvents(journalPath, `${name}:c1`).events, [],
      `${name}: a refused task must seal no run`);
  }

  // An attestation that is absent, signed by another key, expired, edited, or
  // resolved without an OS-boundary pin is no attestation.
  const attestationCases = [
    ['no-attestation', {}, TRUSTED_MODE, 'acceptance_attestation_missing'],
    ['wrong-key', { [ACCEPTANCE_ENV.ATTESTATION]: write('wrong-key-attestation',
      attestationFor(failure, { key: OTHER_KEY.privateKey })) }, TRUSTED_MODE, 'key_mismatch'],
    ['expired', { [ACCEPTANCE_ENV.ATTESTATION]: write('expired-attestation',
      attestationFor(failure, { validUntil: at(-1_000) })) }, TRUSTED_MODE, 'expired'],
    ['no-authority', { [ACCEPTANCE_ENV.ATTESTATION]: attestationFile }, NO_AUTHORITY,
      'acceptance_attestation_untrusted'],
  ];
  for (const [name, environment, authorityMode, detail] of attestationCases) {
    fs.writeFileSync(path.join(root, 'docs', 'version.md'), BASE, 'utf8');
    const refused = runTask({ root, taskFile: baseTaskFile, runId: name, journalPath, environment, authorityMode });
    assert.equal(refused.status, 'refused', `${name}: ${JSON.stringify(refused)}`);
    assert.equal(refused.data.detail, detail, `${name}: ${JSON.stringify(refused)}`);
    assert.equal(fs.readFileSync(path.join(root, 'docs', 'version.md'), 'utf8'), BASE,
      `${name}: a refused task must not write`);
    assert.deepEqual(sealedEvents(journalPath, `${name}:c1`).events, [],
      `${name}: a refused task must seal no run`);
  }

  // An edited envelope fails the signature itself, before any binding is read.
  const editedEnvelope = JSON.parse(JSON.stringify(attestation));
  editedEnvelope.envelope.payload.reason = 'edited after signing';
  fs.writeFileSync(path.join(root, 'docs', 'version.md'), BASE, 'utf8');
  const edited = runTask({ root, taskFile: baseTaskFile, runId: 'edited-envelope', journalPath,
    environment: { [ACCEPTANCE_ENV.ATTESTATION]: write('edited-envelope', editedEnvelope) } });
  assert.equal(edited.status, 'refused', JSON.stringify(edited));
  assert.equal(edited.data.detail, 'signature_invalid', JSON.stringify(edited));
  assert.equal(fs.readFileSync(path.join(root, 'docs', 'version.md'), 'utf8'), BASE);

  // The real process boundary refuses the same untouched task when no
  // OS-boundary pin exists, so an attestation path alone never grants a run.
  fs.writeFileSync(path.join(root, 'docs', 'version.md'), BASE, 'utf8');
  const child = await promisify(execFile)(process.execPath,
    [CLI, 'coder', baseTaskFile, '--root', root, '--json', '--authorize',
      '--journal', journalPath, '--run-id', 'child-no-pin'],
    { cwd: root, encoding: 'utf8', timeout: 120000, windowsHide: true,
      env: {
        ...process.env,
        HUQAN_STATE_ROOT: path.join(fixture, 'state'),
        HUQAN_MEMORY_PATH: path.join(fixture, 'memory.json'),
        HUQAN_DB_PATH: path.join(fixture, 'memory.db'),
        [ACCEPTANCE_ENV.ATTESTATION]: attestationFile,
      } })
    .then((result) => ({ status: 0, stdout: result.stdout }), (error) => ({ status: error.code, stdout: error.stdout }));
  assert.notEqual(child.status, 0, 'a child without a pin must refuse');
  const childJson = JSON.parse(child.stdout);
  assert.notEqual(childJson.status, 'completed', child.stdout);
  assert.equal(childJson.data.reason, SOURCE_CODES.ORACLE_SUPPLY_UNVERIFIED, child.stdout);
  assert.equal(fs.readFileSync(path.join(root, 'docs', 'version.md'), 'utf8'), BASE,
    'the child refusal must not write');
});

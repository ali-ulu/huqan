'use strict';

/**
 * #4621 — a verified Coder failure must reach future behaviour.
 *
 * The issue's remaining gap: the failure-derived candidate was sealed and
 * readable, but nothing proved it was persistently promoted, that the Authority
 * approval was driven by that exact candidate, or that a restarted Coder
 * dispatches the exact admitted source/procedure hash instead of re-deriving
 * one. This file drives one failure through the whole path with real
 * components: the real ErrorPrevention, the real `coder propose` handler and
 * attestation verifier, real `cli.js coder` child processes, the real sealed
 * journal, the real `terfi` loop, a real Authority HTTP service issuing a real
 * Ed25519 decision, and fresh child processes for dispatch.
 *
 * Two boundary notes:
 *   - `coder propose` resolves its trust anchor itself, and a child process
 *     cannot be handed an OS-boundary pin, so the accepting propose case calls
 *     the command handler through the same `authorityMode` seam the CLI fills
 *     from the installed pin. The refusals (no anchor, expired, forged,
 *     conflicting, tampered failure) run through that same seam.
 *   - The promotion runs through the real `terfi` command and the real
 *     `huqan-authority apply`; only pin/consume-key resolution is injected,
 *     exactly as the existing promotion harness does.
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
const { openCoderJournal } = require('../lib/coder/journal-store');
const { buildLearningProposal } = require('../lib/experience/learning-intake');
const { qualify } = require('../lib/experience/compiler');
const { readCoderPromotionReceipt } = require('../lib/experience/coder-promotion-receipt');
const {
  CODES: SOURCE_CODES, ELIGIBILITY, sealedFailureHash, ACCEPTANCE_ENV,
} = require('../lib/experience/learning-source');
const {
  ATTESTATION_TOOL, acceptanceActionHash, allowedPathsHash,
} = require('../lib/experience/acceptance-attestation');
const { signDecision, DECISION_VERSION, keyIdFor } = require('../lib/authority/decision-envelope');
const { createAuthorityState, openAuthorityState } = require('../lib/authority/state-store');
const { openLedgerStore } = require('../lib/authority/ledger-store');
const { createAuthorityService } = require('../lib/authority/authority-service');
const { createAuthorityServer } = require('../lib/authority/http-server');
const { sealDecisionRequest } = require('../lib/authority/sealed-request');
const { totpAt, TOTP_STEP_SECONDS } = require('../lib/authority/totp');
const { createAuthorityClient } = require('../lib/authority/authority-client');
const { parseAuthorityPin } = require('../lib/authority/authority-pin');
const { request, apply } = require('../bin/huqan-authority');

const COMMAND = 'node acceptance.test.js';
const OTHER_COMMAND = 'node other.test.js';
const BASE = 'version v1.0.0\n';
const FIXED = 'version v1.1.0\n';
const WORKSPACE = 'default';

// The pinned authority a host would have installed. Tests mint with the
// matching private key and hand the public one over as the pin.
const AUTHORITY = crypto.generateKeyPairSync('ed25519');
const NOW = Date.now();
const at = (offsetMs) => new Date(NOW + offsetMs).toISOString();
const TRUSTED_MODE = Object.freeze({
  mode: 'service', boundary: 'os-service', pin: Object.freeze({ signingKey: AUTHORITY.publicKey }),
});

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function acceptanceFor(file) {
  return `require('node:assert/strict').equal(require('node:fs').readFileSync(${JSON.stringify(file)}, 'utf8'), ${JSON.stringify(FIXED)});\n`;
}

/** A real Git repository on a feature branch, with the base tree committed. */
function repo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-4621-repo-')));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore', windowsHide: true });
  git('init', '-qb', 'feat/failure-derived');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'user.name', 'fixture');
  git('config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'version.md'), BASE, 'utf8');
  fs.writeFileSync(path.join(root, 'docs', 'other.md'), BASE, 'utf8');
  // The two held-out inputs the coverage gate needs: one where the source text
  // is absent (drift), one where it occurs twice (ambiguous).
  fs.writeFileSync(path.join(root, 'docs', 'drift.md'), 'nothing to see here\n', 'utf8');
  fs.writeFileSync(path.join(root, 'docs', 'ambiguous.md'), `${BASE}${BASE}`, 'utf8');
  fs.writeFileSync(path.join(root, 'acceptance.test.js'), acceptanceFor('docs/version.md'), 'utf8');
  fs.writeFileSync(path.join(root, 'other.test.js'), acceptanceFor('docs/other.md'), 'utf8');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return root;
}

/** A real verified failure record, produced by the real error-prevention engine. */
function verifiedFailure({ observed = 'v1.0.0', expected = 'v1.1.0' } = {}) {
  const prevention = createErrorPrevention(new MemoryStore({ useSQLite: false }), {
    verifyEvidence: ({ source, evidence }) => source === 'test_failure'
      && evidence.some((item) => item?.type === 'test' && item?.verifiedBy === 'ci'),
  });
  const recorded = prevention.recordFailure({
    tool: 'coder', operation: 'replace_text', path: 'docs/version.md', workspaceId: WORKSPACE,
    source: 'test_failure', observed, expected, evidence: [{ type: 'test', verifiedBy: 'ci' }],
  });
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  assert.equal(recorded.failure.verificationStatus, 'verified');
  return recorded.failure;
}

/** A signed acceptance attestation for exactly this evidence. */
function attestationFor(failure, {
  command = COMMAND, allowedPaths = ['docs/version.md'], approvalId = 'acceptance-failure',
  decidedAt = at(-60_000), validUntil = at(9 * 60_000), key = AUTHORITY.privateKey,
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
      decision: 'approved', reason: '', decidedAt, validUntil, ledgerSeq: 3,
      ledgerHash: 'b'.repeat(64), operator: 'totp:primary',
    }, key),
  };
}

function sourceFor(failure, overrides = {}) {
  return {
    hash: sealedFailureHash(failure),
    outcomeStatus: 'verified',
    allowedPaths: ['docs/version.md'],
    oracle: { command: COMMAND },
    ...overrides,
  };
}

/**
 * Run the real `coder propose` handler. `attestation` is `undefined` for "no
 * attestation file", a string for a raw file body, or an object to serialise.
 */
function propose(dir, { failure, source, attestation }) {
  const failureFile = path.join(dir, 'failure.json');
  const sourceFile = path.join(dir, 'source.json');
  fs.writeFileSync(failureFile, JSON.stringify(failure), 'utf8');
  fs.writeFileSync(sourceFile, JSON.stringify(source), 'utf8');
  const environment = {};
  if (attestation !== undefined) {
    const attestationFile = path.join(dir, 'attestation.json');
    fs.writeFileSync(attestationFile,
      typeof attestation === 'string' ? attestation : JSON.stringify(attestation), 'utf8');
    environment[ACCEPTANCE_ENV.ATTESTATION] = attestationFile;
  }
  return runCliCoderPropose([failureFile, '--source', sourceFile, '--json'], {
    json: true, environment, authorityMode: TRUSTED_MODE,
  });
}

/**
 * Run the public CLI as a real child process and parse its JSON envelope.
 *
 * Asynchronous on purpose: a promotion-acceptance child asks the Authority this
 * process hosts, so a synchronous spawn would block the very event loop that
 * has to answer it.
 */
async function coderRun({ root, taskFile, runId, journalPath, sandbox, extra = [], env = {} }) {
  const args = [CLI, 'coder', taskFile, '--root', root, '--json', '--authorize',
    '--journal', journalPath, '--run-id', runId, ...extra];
  const options = {
    cwd: root, encoding: 'utf8', timeout: 120000, windowsHide: true,
    env: {
      ...process.env,
      HUQAN_STATE_ROOT: path.join(sandbox, 'state'),
      HUQAN_MEMORY_PATH: path.join(sandbox, 'memory.json'),
      HUQAN_DB_PATH: path.join(sandbox, 'memory.db'),
      ...env,
    },
  };
  try {
    const result = await promisify(execFile)(process.execPath, args, options);
    return { status: 0, json: result.stdout ? JSON.parse(result.stdout) : null, stderr: result.stderr };
  } catch (error) {
    return { status: error.code, json: error.stdout ? JSON.parse(error.stdout) : null, stderr: error.stderr };
  }
}

function runs(prefix, cost, startAt) {
  return Array.from({ length: 12 }, (_, index) => ({
    occurredAt: startAt + index * 60000,
    learningEligibility: 'positive_procedure',
    executionCost: cost,
    verificationCost: 1,
    canaryOverheadCost: 0,
    eventId: `${prefix}-e${index}`,
    runId: `${prefix}-r${index}`,
  }));
}

/** A passing qualification bound to exactly this procedure's hash. */
function artifact(proposal, sourceRunHashes) {
  const qualification = qualify({
    procedure: proposal.procedure,
    inputs: ['qualification v1.0.0 input'],
    observe: (value) => value,
    apply: (procedure, value) => ({
      sites: value.split(procedure.params.oldText).length - 1,
      after: value.replace(procedure.params.oldText, () => procedure.params.newText),
    }),
  });
  assert.equal(qualification.qualified, true, JSON.stringify(qualification));
  assert.equal(qualification.procedureHash, proposal.procedure.hash);
  return { procedure: proposal.procedure, qualification, sourceRunHashes };
}

async function openAuthority(fixture) {
  const created = createAuthorityState({ dir: path.join(fixture, 'authority') });
  const state = openAuthorityState({ dir: path.join(fixture, 'authority'), operatorId: 'operator' });
  const service = createAuthorityService({
    state, ledger: openLedgerStore({ file: path.join(fixture, 'ledger.jsonl') }),
  });
  const server = createAuthorityServer({ service, signingKey: state.signingKey });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const pinFile = path.join(fixture, 'pin.json');
  fs.writeFileSync(pinFile, JSON.stringify({
    v: 'huqan.authority.pin.v1', port: server.address().port,
    keyId: keyIdFor(created.signingPublicKeyPem),
    signingKey: created.signingPublicKeyPem, sealingKey: created.sealingPublicKeyPem,
  }), 'utf8');
  const pin = parseAuthorityPin(fs.readFileSync(pinFile, 'utf8')).pin;
  const consumeKey = crypto.randomBytes(32);
  return {
    created, pinFile, pin,
    deps: { resolveMode: () => ({ mode: 'service', boundary: 'os-service', pin }), loadConsumeKey: () => consumeKey },
    client: createAuthorityClient({ pin }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Register a `terfi` request over these four input files and return its id. */
async function registerPromotion(authority, fixture, journalPath, files) {
  const digests = {};
  const argv = [];
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(fixture, `${name}.json`);
    const text = JSON.stringify(value);
    fs.writeFileSync(file, text, 'utf8');
    digests[name] = sha256(text);
    argv.push(`--${name}`, file);
  }
  argv.push('--capability', 'failure-derived', '--onaylayan', os.userInfo().username,
    '--karar', 'approved', '--journal', journalPath);
  const registered = await request('terfi', { argsJson: JSON.stringify({ argv, digests }) }, authority.deps);
  assert.equal(registered.code, 0, JSON.stringify(registered.report));
  return registered.report.approvalId;
}

async function decide(authority, approvalId, decision, counterOffset) {
  const shown = await authority.client.show(approvalId);
  assert.equal(shown.status, 200, JSON.stringify(shown.body));
  const sealed = sealDecisionRequest({
    approvalId, actionHash: shown.body.approval.actionHash, decision, reason: 'checked',
    totp: totpAt(authority.created.totpSecret,
      Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS) + counterOffset),
  }, authority.created.sealingPublicKeyPem);
  const decided = await authority.client.decide(approvalId, sealed);
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
}

function dispatchTask({ id, target, command, candidate }) {
  return {
    id, level: 'l0', allowedPaths: [target],
    operation: { type: 'replace_text', path: target, find: 'v1.0.0', replace: 'v1.1.0' },
    test: { command },
    experience: { riskTier: 'low', candidates: [candidate] },
  };
}

test('#4621 a failure-derived candidate refuses unattested, expired, forged and conflicting sources', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-4621-propose-'));
  try {
    const failure = verifiedFailure();

    const unattested = propose(dir, { failure, source: sourceFor(failure) });
    assert.equal(unattested.data.status, PRODUCER_STATUSES.NEEDS_HUMAN_DECISION);
    assert.equal(unattested.data.reason, SOURCE_CODES.ORACLE_SUPPLY_UNVERIFIED);
    assert.equal(unattested.data.task, null);

    const expired = propose(dir, {
      failure, source: sourceFor(failure),
      attestation: attestationFor(failure, { decidedAt: at(-9 * 60_000), validUntil: at(-8 * 60_000) }),
    });
    assert.equal(expired.data.reason, SOURCE_CODES.ORACLE_SUPPLY_UNVERIFIED);
    assert.equal(expired.data.task, null);

    const forged = propose(dir, {
      failure, source: sourceFor(failure),
      attestation: attestationFor(failure, { key: crypto.generateKeyPairSync('ed25519').privateKey }),
    });
    assert.equal(forged.data.reason, SOURCE_CODES.ORACLE_SUPPLY_UNVERIFIED);
    assert.equal(forged.data.task, null);

    // The same signature over a different failure is a different claim.
    const otherFailure = verifiedFailure({ observed: 'v0.9.0', expected: 'v1.1.0' });
    const rebound = propose(dir, {
      failure, source: sourceFor(failure), attestation: attestationFor(otherFailure),
    });
    assert.equal(rebound.data.reason, SOURCE_CODES.ORACLE_SUPPLY_UNVERIFIED);
    assert.equal(rebound.data.task, null);

    const tampered = propose(dir, {
      failure: { ...failure, observed: 'v0.0.1' }, source: sourceFor(failure),
      attestation: attestationFor(failure),
    });
    assert.equal(tampered.data.reason, SOURCE_CODES.SOURCE_HASH_MISMATCH);
    assert.equal(tampered.data.task, null);

    const conflicting = propose(dir, {
      failure, source: sourceFor(failure, { verificationConflicting: true }),
      attestation: attestationFor(failure),
    });
    assert.equal(conflicting.data.status, PRODUCER_STATUSES.NEEDS_HUMAN_DECISION);
    assert.equal(conflicting.data.reason, SOURCE_CODES.OUTCOME_CONFLICTING);
    assert.equal(conflicting.data.task, null);

    const accepted = propose(dir, {
      failure, source: sourceFor(failure), attestation: attestationFor(failure),
    });
    assert.equal(accepted.data.status, PRODUCER_STATUSES.TASK_PRODUCED);
    assert.equal(accepted.data.learningEligibility, ELIGIBILITY.POSITIVE_PROCEDURE);
    assert.equal(accepted.data.task.learningSource.sourceHash, sealedFailureHash(failure));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#4621 a verified failure traverses the sealed journal, promotion, Authority approval and a fresh process', async (t) => {
  const savedEnv = { HUQAN_MEMORY_PATH: process.env.HUQAN_MEMORY_PATH, HUQAN_DB_PATH: process.env.HUQAN_DB_PATH };
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-4621-')));
  const root = repo();
  const sandbox = path.join(fixture, 'sandbox');
  fs.mkdirSync(sandbox, { recursive: true });
  const journalPath = path.join(fixture, 'evidence.db');
  const taskFile = path.join(fixture, 'task.json');
  const authority = await openAuthority(fixture);
  process.env.HUQAN_MEMORY_PATH = path.join(sandbox, 'cli-memory.json');
  process.env.HUQAN_DB_PATH = path.join(sandbox, 'cli-memory.db');
  t.after(async () => {
    await authority.close();
    process.env.HUQAN_MEMORY_PATH = savedEnv.HUQAN_MEMORY_PATH;
    process.env.HUQAN_DB_PATH = savedEnv.HUQAN_DB_PATH;
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  // 1. A real verified failure becomes a learning-eligible task only through a
  //    signed acceptance attestation.
  const failure = verifiedFailure();
  const sourceHash = sealedFailureHash(failure);
  const attestation = attestationFor(failure);
  const proposed = propose(fixture, { failure, source: sourceFor(failure), attestation });
  assert.equal(proposed.data.status, PRODUCER_STATUSES.TASK_PRODUCED, JSON.stringify(proposed.data));
  const task = proposed.data.task;
  assert.equal(task.test.command, COMMAND);
  assert.equal(task.learningSource.eligibility, ELIGIBILITY.POSITIVE_PROCEDURE);
  assert.equal(task.learningSource.sourceHash, sourceHash);
  assert.equal(task.learningSource.oracle.channel, 'ci');
  assert.equal(task.learningSource.oracle.approvalId, attestation.envelope.payload.approvalId);
  assert.equal(task.learningSource.oracle.actionHash, attestation.envelope.payload.actionHash);

  // 2. The task runs through the public CLI and the run is sealed with that
  //    evidence inside it, not with what a caller now claims.
  fs.writeFileSync(taskFile, JSON.stringify(task), 'utf8');
  const sourceRun = await coderRun({ root, taskFile, runId: 'failure-source', journalPath, sandbox });
  assert.equal(sourceRun.status, 0, sourceRun.stderr);
  assert.equal(sourceRun.json.status, 'completed', JSON.stringify(sourceRun.json));
  assert.equal(sourceRun.json.data.outcome, 'applied_tested');
  assert.equal(fs.readFileSync(path.join(root, 'docs', 'version.md'), 'utf8'), FIXED);
  const sourceRunId = 'failure-source:c1';

  let store = openCoderJournal(journalPath);
  let proposal;
  try {
    const events = store.journal.read(sourceRunId);
    assert.deepEqual(events.map((event) => event.type), [
      'run_started', 'action_proposed', 'policy_decided',
      'execution_started', 'execution_finished', 'verification', 'run_closed',
    ]);
    // The command body stays out of the journal; its hash is what is sealed.
    const { command: _command, ...oracleWithoutCommand } = task.learningSource.oracle;
    const sealedSource = events[0].payload.learningSource;
    assert.deepEqual(sealedSource, { ...task.learningSource, oracle: oracleWithoutCommand });
    // The sealed fields recompute the hash the Authority signed: the record
    // carries the evidence, not a label about it.
    assert.equal(acceptanceActionHash({
      sourceHash: sealedSource.sourceHash,
      commandHash: sealedSource.oracle.commandHash,
      allowedPathsHash: allowedPathsHash(sealedSource.allowedPaths),
      channel: sealedSource.oracle.channel,
      approvalId: sealedSource.oracle.approvalId,
      workspaceId: WORKSPACE,
    }), sealedSource.oracle.actionHash);
    assert.equal(store.journal.manifest(sourceRunId).learningEligibility, 'positive_procedure');
    assert.equal(store.journal.manifest(sourceRunId).closed, true);

    proposal = buildLearningProposal(store.journal, {
      runId: sourceRunId, workspaceId: WORKSPACE,
      params: { path: 'docs/version.md', oldText: 'v1.0.0', newText: 'v1.1.0' },
    });
    assert.equal(proposal.ok, true, proposal.code);
    assert.equal(proposal.eligibility, ELIGIBILITY.POSITIVE_PROCEDURE);
    assert.equal(proposal.admission.decision, 'admitted');
    assert.equal(proposal.registered, false, 'a proposal must never install itself');
    // Read back from the sealed record, not asserted by the caller.
    assert.equal(proposal.learningSource.sourceHash, sourceHash);
    assert.equal(proposal.learningSource.oracle.commandHash, sha256(COMMAND));
    assert.equal(proposal.learningSource.oracle.actionHash, attestation.envelope.payload.actionHash);
    assert.deepEqual(proposal.learningSource.allowedPaths, ['docs/version.md']);
    assert.equal(proposal.candidate.status, 'candidate');
    assert.equal(proposal.procedure.kind, 'replace_text');
    assert.equal(proposal.procedure.version, 1);
  } finally {
    store.close();
  }

  // 3. A failure whose own acceptance test fails keeps its negative outcome and
  //    proposes no procedure: evaluation is the run's, not the caller's.
  fs.writeFileSync(path.join(root, 'docs', 'version.md'), BASE, 'utf8');
  const negativeFailure = verifiedFailure({ observed: 'v1.0.0', expected: 'v9.9.9' });
  const negativeTask = propose(fixture, {
    failure: negativeFailure, source: sourceFor(negativeFailure), attestation: attestationFor(negativeFailure),
  }).data.task;
  assert.equal(negativeTask.learningSource.eligibility, ELIGIBILITY.POSITIVE_PROCEDURE);
  const negativeTaskFile = path.join(fixture, 'negative-task.json');
  fs.writeFileSync(negativeTaskFile, JSON.stringify(negativeTask), 'utf8');
  const negativeRun = await coderRun({ root, taskFile: negativeTaskFile, runId: 'failure-negative', journalPath, sandbox });
  assert.notEqual(negativeRun.json?.status, 'completed', JSON.stringify(negativeRun.json));
  assert.equal(negativeRun.json.data.attempts[0].test.ok, false, 'the declared test must actually run and fail');
  assert.equal(fs.readFileSync(path.join(root, 'docs', 'version.md'), 'utf8'), BASE, 'a failed test must roll back');
  store = openCoderJournal(journalPath);
  try {
    const negativeEvents = store.journal.read('failure-negative:c1');
    const verification = negativeEvents.find((event) => event.type === 'verification');
    assert.equal(verification.outcomeStatus, 'failed');
    assert.equal(store.journal.manifest('failure-negative:c1').learningEligibility, 'negative_example');
    const negativeProposal = buildLearningProposal(store.journal, {
      runId: 'failure-negative:c1', workspaceId: WORKSPACE,
      params: { path: 'docs/version.md', oldText: 'v1.0.0', newText: 'v9.9.9' },
    });
    assert.equal(negativeProposal.ok, true, negativeProposal.code);
    // The failure is kept as a negative example, never compiled into a
    // procedure: admission of a negative record produces no candidate.
    assert.equal(negativeProposal.eligibility, 'negative_example');
    assert.equal(negativeProposal.candidate, null);
    assert.equal(negativeProposal.procedure, null);
    assert.equal(negativeProposal.registered, false);
  } finally {
    store.close();
  }

  // 4. Promotion runs through the real `terfi` gate with the Authority's own
  //    decision, and the receipt binds this exact procedure.
  store = openCoderJournal(journalPath);
  let bound;
  let candidate;
  try {
    const params = { path: 'docs/version.md', oldText: 'v1.0.0', newText: 'v1.1.0' };
    bound = buildLearningProposal(store.journal, { runId: sourceRunId, workspaceId: WORKSPACE, params, parentVersion: 0 });
    candidate = buildLearningProposal(store.journal, { runId: sourceRunId, workspaceId: WORKSPACE, params, parentVersion: 1 });
    assert.equal(bound.ok, true, bound.code);
    assert.equal(candidate.ok, true, candidate.code);
  } finally {
    store.close();
  }
  const sourceRunHashes = [{ runId: sourceRunId, sourceHash: proposal.sourceHash }];
  const startAt = Date.now() - 3600000;
  const approvalId = await registerPromotion(authority, fixture, journalPath, {
    aday: artifact(candidate, sourceRunHashes),
    bagli: artifact(bound, sourceRunHashes),
    deneme: {
      candidateRuns: runs('candidate', 5, startAt),
      baselineWindowRuns: runs('baseline', 10, startAt),
      startAt,
    },
    gozlem: { currentEvents: runs('observed', 5, startAt) },
  });
  await decide(authority, approvalId, 'approved', 0);
  const applied = await apply(approvalId, {}, authority.deps);
  assert.equal(applied.code, 0, JSON.stringify(applied.report));
  assert.equal(applied.report.executed, true);
  assert.equal(applied.report.promotionReceiptStored, true);

  const admitted = candidate.procedure.hash;
  store = openCoderJournal(journalPath);
  try {
    const stored = readCoderPromotionReceipt({
      journal: store.journal, approvalId, workspaceId: WORKSPACE, publicKey: authority.pin.signingKey,
    });
    assert.equal(stored.ok, true, stored.code);
    assert.equal(stored.receipt.outcome, 'promoted');
    assert.equal(stored.receipt.nextProcedure.hash, admitted);
    assert.equal(stored.receipt.previousProcedure.hash, bound.procedure.hash);
    assert.deepEqual(stored.receipt.sourceRunHashes, sourceRunHashes);
    // The admitted procedure is the one derived from the sealed failure run.
    const sealed = store.journal.read(sourceRunId);
    assert.equal(sealed[0].payload.learningSource.sourceHash, sourceHash);
    assert.equal(stored.receipt.actionHash, (await authority.client.show(approvalId)).body.approval.actionHash);
  } finally {
    store.close();
  }

  // 5. A fresh process dispatches a new task and selects exactly that admitted
  //    procedure hash, verified against the live Authority decision.
  fs.writeFileSync(path.join(root, 'docs', 'version.md'), BASE, 'utf8');
  const dispatchFile = path.join(fixture, 'dispatch.json');
  fs.writeFileSync(dispatchFile, JSON.stringify(dispatchTask({
    id: 'fresh-process', target: 'docs/version.md', command: COMMAND,
    candidate: {
      capabilityId: 'failure-derived', sourceRunIds: [sourceRunId], parentVersion: 1,
      qualificationPaths: ['docs/drift.md', 'docs/ambiguous.md'],
    },
  })), 'utf8');
  const dispatched = await coderRun({
    root, taskFile: dispatchFile, runId: 'fresh-process', journalPath, sandbox,
    extra: ['--promotion-approval', approvalId, '--promotion-capability', 'failure-derived'],
    env: { HUQAN_AUTHORITY_PIN_PATH: authority.pinFile },
  });
  assert.equal(dispatched.status, 0, JSON.stringify(dispatched.json));
  assert.equal(dispatched.json.status, 'completed', JSON.stringify(dispatched.json));
  assert.equal(dispatched.json.data.attempts[0].test.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'docs', 'version.md'), 'utf8'), FIXED);
  store = openCoderJournal(journalPath);
  try {
    const decision = store.journal.read('fresh-process:c1').find((event) => event.type === 'routing_decided');
    assert.equal(decision.payload.chosenCapabilityId, 'failure-derived');
    assert.equal(decision.payload.boundProcedureVersion, admitted);
  } finally {
    store.close();
  }

  // 6. A disjoint target in another fresh process carries the exact admitted
  //    source procedure hash as the transfer's origin.
  fs.writeFileSync(path.join(root, 'docs', 'version.md'), BASE, 'utf8');
  const transferFile = path.join(fixture, 'transfer.json');
  fs.writeFileSync(transferFile, JSON.stringify(dispatchTask({
    id: 'fresh-transfer', target: 'docs/other.md', command: OTHER_COMMAND,
    candidate: {
      // A transfer is a distinct capability identity: the trust replay binds
      // one capability to one procedure hash, and the specialised procedure
      // here is not the admitted one.
      capabilityId: 'failure-derived-transfer', sourceRunIds: [sourceRunId], parentVersion: 1,
      sourcePath: 'docs/version.md', sourceProcedureHash: admitted,
      qualificationPaths: ['docs/drift.md', 'docs/ambiguous.md'],
    },
  })), 'utf8');
  const transferred = await coderRun({ root, taskFile: transferFile, runId: 'fresh-transfer', journalPath, sandbox });
  assert.equal(transferred.status, 0, JSON.stringify(transferred.json));
  assert.equal(transferred.json.status, 'completed', JSON.stringify(transferred.json));
  assert.equal(fs.readFileSync(path.join(root, 'docs', 'other.md'), 'utf8'), FIXED);
  store = openCoderJournal(journalPath);
  try {
    const decision = store.journal.read('fresh-transfer:c1').find((event) => event.type === 'routing_decided');
    assert.equal(decision.payload.transfer.sourceProcedureHash, admitted);
    assert.equal(decision.payload.transfer.sourcePath, 'docs/version.md');
    assert.equal(decision.payload.transfer.targetPath, 'docs/other.md');
  } finally {
    store.close();
  }

  // 7. The fresh process refuses to re-derive: a task that names the target
  //    path as its own source cannot inherit the admitted procedure.
  fs.writeFileSync(path.join(root, 'docs', 'other.md'), BASE, 'utf8');
  const rederived = JSON.parse(fs.readFileSync(transferFile, 'utf8'));
  delete rederived.experience.candidates[0].sourcePath;
  delete rederived.experience.candidates[0].sourceProcedureHash;
  const rederivedFile = path.join(fixture, 'rederived.json');
  fs.writeFileSync(rederivedFile, JSON.stringify({ ...rederived, id: 're-derived' }), 'utf8');
  const refusedRederivation = await coderRun({ root, taskFile: rederivedFile, runId: 're-derived', journalPath, sandbox });
  assert.notEqual(refusedRederivation.status, 0, JSON.stringify(refusedRederivation.json));
  assert.match(JSON.stringify(refusedRederivation.json), /source_procedure_mismatch/);
  assert.equal(fs.readFileSync(path.join(root, 'docs', 'other.md'), 'utf8'), BASE);

  // 8. A tampered source procedure hash, a different final version and a
  //    different capability are all refused, and nothing is written.
  for (const [name, mutate, pattern] of [
    ['tampered-hash', (value) => { value.experience.candidates[0].sourceProcedureHash = 'a'.repeat(64); },
      /source_procedure_mismatch/],
    ['wrong-version', (value) => { value.experience.candidates[0].parentVersion = 2; },
      /source_procedure_mismatch|PROMOTION_ACCEPTANCE_BINDING_MISMATCH/],
  ]) {
    fs.writeFileSync(path.join(root, 'docs', 'other.md'), BASE, 'utf8');
    const altered = JSON.parse(fs.readFileSync(transferFile, 'utf8'));
    mutate(altered);
    const file = path.join(fixture, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...altered, id: name }), 'utf8');
    const refused = await coderRun({ root, taskFile: file, runId: name, journalPath, sandbox });
    assert.notEqual(refused.status, 0, `${name}: ${JSON.stringify(refused.json)}`);
    assert.match(JSON.stringify(refused.json), pattern);
    assert.equal(fs.readFileSync(path.join(root, 'docs', 'other.md'), 'utf8'), BASE);
  }
  fs.writeFileSync(path.join(root, 'docs', 'version.md'), BASE, 'utf8');
  const wrongCapability = await coderRun({
    root, taskFile: dispatchFile, runId: 'wrong-capability', journalPath, sandbox,
    extra: ['--promotion-approval', approvalId, '--promotion-capability', 'another-capability'],
    env: { HUQAN_AUTHORITY_PIN_PATH: authority.pinFile },
  });
  assert.notEqual(wrongCapability.status, 0, JSON.stringify(wrongCapability.json));
  assert.match(JSON.stringify(wrongCapability.json), /promotion_binding_mismatch/);
  assert.equal(fs.readFileSync(path.join(root, 'docs', 'version.md'), 'utf8'), BASE);

  // 9. A path escape is refused before any write, and the tree is untouched.
  const escapeFile = path.join(fixture, 'escape.json');
  fs.writeFileSync(escapeFile, JSON.stringify({
    id: 'path-escape', level: 'l0', allowedPaths: ['docs/version.md'],
    operation: { type: 'replace_text', path: '../escape.md', find: 'v1.0.0', replace: 'v1.1.0' },
    test: { command: COMMAND },
  }), 'utf8');
  const escaped = await coderRun({ root, taskFile: escapeFile, runId: 'path-escape', journalPath, sandbox });
  assert.notEqual(escaped.status, 0, JSON.stringify(escaped.json));
  assert.equal(fs.existsSync(path.join(fixture, 'escape.md')), false);
  assert.equal(fs.readFileSync(path.join(root, 'docs', 'version.md'), 'utf8'), BASE);

  // 10. A rejected approval carries no receipt, so the fresh process has
  //     nothing to accept.
  const rejectedId = await registerPromotion(authority, fixture, journalPath, {
    aday: artifact(candidate, sourceRunHashes),
    bagli: artifact(bound, sourceRunHashes),
    deneme: {
      candidateRuns: runs('rejected-candidate', 5, startAt),
      baselineWindowRuns: runs('rejected-baseline', 10, startAt),
      startAt,
    },
    gozlem: { currentEvents: runs('rejected-observed', 5, startAt) },
  });
  await decide(authority, rejectedId, 'rejected', 1);
  const notApplied = await apply(rejectedId, {}, authority.deps);
  assert.equal(notApplied.report.executed, false, JSON.stringify(notApplied.report));
  store = openCoderJournal(journalPath);
  try {
    assert.equal(readCoderPromotionReceipt({
      journal: store.journal, approvalId: rejectedId, workspaceId: WORKSPACE, publicKey: authority.pin.signingKey,
    }).code, 'promotion_receipt_missing');
  } finally {
    store.close();
  }
  const afterRejection = await coderRun({
    root, taskFile: dispatchFile, runId: 'after-rejection', journalPath, sandbox,
    extra: ['--promotion-approval', rejectedId, '--promotion-capability', 'failure-derived'],
    env: { HUQAN_AUTHORITY_PIN_PATH: authority.pinFile },
  });
  assert.notEqual(afterRejection.status, 0, JSON.stringify(afterRejection.json));
  assert.match(JSON.stringify(afterRejection.json), /promotion_receipt_missing/);
  assert.equal(fs.readFileSync(path.join(root, 'docs', 'version.md'), 'utf8'), BASE);
});

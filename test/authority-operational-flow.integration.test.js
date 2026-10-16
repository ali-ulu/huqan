'use strict';

// #3892 end to end: an operator action with no approval row is registered
// with a real authority service (`huqan-authority request`), decided with the
// operator's sealed TOTP code, and carried out once by `huqan-authority
// apply`, which hands the signed envelopes to the surface in-process.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createAuthorityState, openAuthorityState } = require('../lib/authority/state-store');
const { openLedgerStore } = require('../lib/authority/ledger-store');
const { createAuthorityService } = require('../lib/authority/authority-service');
const { createAuthorityServer } = require('../lib/authority/http-server');
const { parseAuthorityPin } = require('../lib/authority/authority-pin');
const { createAuthorityClient } = require('../lib/authority/authority-client');
const { keyIdFor } = require('../lib/authority/decision-envelope');
const { sealDecisionRequest } = require('../lib/authority/sealed-request');
const { totpAt, TOTP_STEP_SECONDS } = require('../lib/authority/totp');
const { verifyAutonomyActivation } = require('../lib/authority/autonomy-activation');
const { createEmergencyStop } = require('../lib/emergency-stop');
const { request, apply } = require('../bin/huqan-authority');

const ROOT = path.resolve(__dirname, '..');

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-authority-ops-'));
  const isolated = { HUQAN_EMERGENCY_STOP_DIR: path.join(dir, 'stops'), HUQAN_MEMORY_PATH: path.join(dir, 'memory.json'),
    HUQAN_DB_PATH: path.join(dir, 'memory.db') };
  const saved = Object.fromEntries(Object.keys(isolated).map(key => [key, process.env[key]]));
  Object.assign(process.env, isolated);
  const created = createAuthorityState({ dir: path.join(dir, 'state') });
  const state = openAuthorityState({ dir: path.join(dir, 'state') });
  const ledger = openLedgerStore({ file: path.join(dir, 'ledger.jsonl') });
  const httpServer = createAuthorityServer({ service: createAuthorityService({ ledger, state }), signingKey: state.signingKey });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const pinText = JSON.stringify({ v: 'huqan.authority.pin.v1', port: httpServer.address().port,
    keyId: keyIdFor(created.signingPublicKeyPem), signingKey: created.signingPublicKeyPem, sealingKey: created.sealingPublicKeyPem });
  const pinPath = path.join(dir, 'pin.json');
  fs.writeFileSync(pinPath, pinText);
  const pin = parseAuthorityPin(pinText).pin;
  t.after(() => new Promise((resolve) => httpServer.close(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    resolve();
  })));
  const mode = { mode: 'service', boundary: 'env-override', pin };
  const consumeKey = crypto.randomBytes(32);
  const deps = { resolveMode: () => mode, loadConsumeKey: () => consumeKey };
  return { dir, created, pin, pinPath, ledger, mode, deps, client: createAuthorityClient({ pin }) };
}

async function operatorDecides(env, approvalId, decision = 'approved') {
  const shown = await env.client.show(approvalId);
  const totp = totpAt(env.created.totpSecret, Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS));
  const sealed = sealDecisionRequest({ approvalId, actionHash: shown.body.approval.actionHash, decision, reason: 'checked', totp },
    env.created.sealingPublicKeyPem);
  const answer = await env.client.decide(approvalId, sealed);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
}

const ledgerTypes = (env, approvalId) => env.ledger.all().filter(e => e.body?.approvalId === approvalId).map(e => e.type);

test('request, decide, apply: an emergency-stop lift runs once, through the guarded ledger', async (t) => {
  const env = await setup(t);
  const stops = createEmergencyStop({ resolveAuthorityMode: () => env.mode });
  stops.stop({ scope: 'workspace', workspaceId: 'ws-1', reason: 'incident', actor: 'operator:cli' });
  const direct = stops.lift({ scope: 'workspace', workspaceId: 'ws-1', reason: 'incident closed', actor: 'operator:cli' });
  assert.equal(direct.authorityRefusal.code, 'AUTHORITY_DECISION_REQUIRED');

  const requested = await request('huqan.emergency_stop', { workspaceId: 'ws-1',
    argsJson: JSON.stringify({ action: 'lift', scope: 'workspace', workspaceId: 'ws-1', agentId: '', reason: 'incident closed' }) }, env.deps);
  assert.equal(requested.code, 0, JSON.stringify(requested.report));
  const { approvalId } = requested.report;
  assert.match(approvalId, /^ops-/);
  assert.equal((await apply(approvalId, {}, env.deps)).code, 3, 'nothing runs before the operator decides');
  assert.equal(stops.check({ workspaceId: 'ws-1' }).stopped, true);

  await operatorDecides(env, approvalId);
  const applied = await apply(approvalId, {}, env.deps);
  assert.equal(applied.code, 0, JSON.stringify(applied.report));
  assert.equal(applied.report.executed, true);
  assert.equal(stops.check({ workspaceId: 'ws-1' }).stopped, false, 'the lift happened');
  assert.deepEqual(ledgerTypes(env, approvalId), ['approval.registered', 'approval.decided', 'approval.consumed', 'approval.outcome']);

  const again = await apply(approvalId, {}, env.deps);
  assert.deepEqual(again, { code: 0, report: { approvalId, decision: 'approved', alreadyFinal: 'executed' } });
  assert.equal(ledgerTypes(env, approvalId).length, 4, 'a second apply spends and records nothing');
});

test('an operator rejection of an operational approval consumes and runs nothing', async (t) => {
  const env = await setup(t);
  const requested = await request('huqan.autonomy_activation', { workspaceId: 'ws-1', argsJson: '{}' }, env.deps);
  await operatorDecides(env, requested.report.approvalId, 'rejected');
  const applied = await apply(requested.report.approvalId, {}, env.deps);
  assert.deepEqual(applied, { code: 0, report: { approvalId: requested.report.approvalId, decision: 'rejected', executed: false } });
  assert.deepEqual(ledgerTypes(env, requested.report.approvalId), ['approval.registered', 'approval.decided']);
});

test('request refuses a tool that is not operational and arguments that are not an object', async (t) => {
  const env = await setup(t);
  assert.equal((await request('huqan.learn', { argsJson: '{}' }, env.deps)).report.error, 'NOT_OPERATIONAL');
  assert.equal((await request('terfi', { argsJson: '[1]' }, env.deps)).report.error, 'ARGS_NOT_AN_OBJECT');
  assert.equal((await request('terfi', { argsJson: 'nope' }, env.deps)).report.error, 'ARGS_NOT_AN_OBJECT');
  const legacy = await request('terfi', { argsJson: '{}' }, { ...env.deps, resolveMode: () => ({ mode: 'legacy' }) });
  assert.equal(legacy.code, 2, 'there is no authority to register with');
});

test('apply refuses a --workspace that is not the one the operator decided', async (t) => {
  const env = await setup(t);
  const requested = await request('huqan.autonomy_activation', { workspaceId: 'ws-1', argsJson: '{}' }, env.deps);
  await operatorDecides(env, requested.report.approvalId);
  const applied = await apply(requested.report.approvalId, { workspaceId: 'ws-2' }, env.deps);
  assert.equal(applied.report.error, 'WORKSPACE_MISMATCH');
  assert.deepEqual(ledgerTypes(env, requested.report.approvalId), ['approval.registered', 'approval.decided']);
});

test('an executor refusal is recorded as a failed outcome', async (t) => {
  const env = await setup(t);
  const requested = await request('huqan.emergency_stop', { workspaceId: 'ws-1',
    argsJson: JSON.stringify({ action: 'stop', scope: 'workspace', workspaceId: 'ws-1', reason: 'x' }) }, env.deps);
  await operatorDecides(env, requested.report.approvalId);
  const applied = await apply(requested.report.approvalId, {}, env.deps);
  assert.equal(applied.code, 2);
  assert.equal(applied.report.error, 'INVALID_ACTION', 'stopping is not decided by the authority');
  const outcome = env.ledger.all().find(e => e.type === 'approval.outcome' && e.body.approvalId === requested.report.approvalId);
  assert.equal(outcome.body.status, 'failed');
});

test('an autonomy activation verifies only once applied, only in its workspace, only as an activation', async (t) => {
  const env = await setup(t);
  const requested = await request('huqan.autonomy_activation', { workspaceId: 'ws-1', argsJson: '{"note":"pilot"}' }, env.deps);
  const { approvalId } = requested.report;
  const verify = (fields = {}) => verifyAutonomyActivation({ mode: env.mode, approvalId, workspaceId: 'ws-1', ...fields });
  assert.equal((await verify()).code, 'AUTHORITY_DECISION_REQUIRED');
  await operatorDecides(env, approvalId);
  assert.equal((await verify()).code, 'AUTHORITY_CONSUMPTION_REQUIRED');
  assert.equal((await apply(approvalId, {}, env.deps)).code, 0);

  const verified = await verify();
  assert.equal(verified.ok, true, JSON.stringify(verified));
  assert.equal(verified.actor, 'totp:primary');
  assert.equal((await verify({ workspaceId: 'ws-2' })).code, 'AUTHORITY_DECISION_INVALID');

  const lift = await request('huqan.emergency_stop', { workspaceId: 'ws-1', argsJson: '{"action":"lift"}' }, env.deps);
  const foreign = await verifyAutonomyActivation({ mode: env.mode, approvalId: lift.report.approvalId, workspaceId: 'ws-1' });
  assert.equal(foreign.code, 'AUTHORITY_DECISION_INVALID');
  assert.match(foreign.message, /not an autonomy activation/);
  assert.equal((await verifyAutonomyActivation({ mode: env.mode, approvalId: 'ops-unknown', workspaceId: 'ws-1' })).code,
    'AUTHORITY_DECISION_REQUIRED');
});

// The hook must reach the in-process service, so the child runs without
// blocking this event loop.
function runHook(env, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'huqan-gate-hook.js'), '--profile', 'generic',
      '--workspace-root', ROOT, '--workspace-id', 'ws-1', '--receipt-log', path.join(env.dir, 'receipts.jsonl'),
      '--memory-path', path.join(env.dir, 'memory.json'), '--db-path', path.join(env.dir, 'memory.db'), ...args], {
      cwd: ROOT,
      env: { ...process.env, HUQAN_AUTHORITY_PIN_PATH: env.pinPath, HUQAN_EXTERNAL_GUARD_REQUIRE_IDENTITY: 'allow',
        HUQAN_EXTERNAL_GUARD_REQUIRE_SIGNED_IDENTITY: 'allow' },
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', status => resolve({ status, stderr }));
    child.stdin.end(JSON.stringify({ invocationId: 'ops-hook', agentName: 'agent-3892', sessionId: 's', toolName: 'shell',
      args: { command: 'git status' }, cwd: ROOT, workspaceRoot: ROOT }));
  });
}

test('the gate hook accepts an applied activation and fails closed on one the authority never decided', async (t) => {
  const env = await setup(t);
  const requested = await request('huqan.autonomy_activation', { workspaceId: 'ws-1', argsJson: '{}' }, env.deps);
  const { approvalId } = requested.report;

  const undecided = await runHook(env, ['--graduated-autonomy', '--autonomy-activation', approvalId, '--human-approver', 'ali']);
  assert.equal(undecided.status, 2);
  assert.match(undecided.stderr, /refused by the approval authority: AUTHORITY_DECISION_REQUIRED/);

  await operatorDecides(env, approvalId);
  assert.equal((await apply(approvalId, {}, env.deps)).code, 0);
  const applied = await runHook(env, ['--graduated-autonomy', '--autonomy-activation', approvalId, '--human-approver', 'ali']);
  assert.doesNotMatch(applied.stderr, /approval authority/);
  assert.notEqual(applied.status, 2, applied.stderr);
});

const MIN = 60 * 1000;
const T0 = Date.now() - 60 * MIN;
const SCOPE = Object.freeze({ tools: Object.freeze(['read']) });

function runs(count, { cost = 10, from = 0 } = {}) {
  return Array.from({ length: count }, (_, i) => ({ occurredAt: T0 + (from + i) * MIN, learningEligibility: 'positive_procedure',
    executionCost: cost, verificationCost: 1, canaryOverheadCost: 0, eventId: `e${from + i}`, runId: `r${from + i}` }));
}

// The same promotion inputs test/cli-promote.test.js drives; the authority
// binds the flags and the digest of each file's text.
function promotionInputs(dir, { candidateCost = 5 } = {}) {
  const contents = {
    aday: { kind: 'replace_text', version: 'v2', scope: SCOPE, params: { path: 'a', oldText: 'x', newText: 'y' } },
    bagli: { kind: 'replace_text', version: 'v1', scope: SCOPE, params: { path: 'a', oldText: 'w', newText: 'x' } },
    deneme: { candidateRuns: runs(12, { cost: candidateCost }), baselineWindowRuns: runs(12, { cost: 10 }), startAt: T0 },
    gozlem: { currentEvents: runs(12, { cost: 5, from: 100 }) },
  };
  const argv = [];
  const digests = {};
  for (const [label, content] of Object.entries(contents)) {
    const file = path.join(dir, `${label}.json`);
    const text = JSON.stringify(content);
    fs.writeFileSync(file, text);
    argv.push(`--${label}`, file);
    digests[label] = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  }
  argv.push('--capability', 'cap', '--onaylayan', os.userInfo().username, '--karar', 'approved');
  return { argv, digests };
}

test('terfi in service mode refuses without the authority and promotes once it is applied', async (t) => {
  const env = await setup(t);
  const { runPromoteCommand } = require('../lib/cli-promote');
  const { argv, digests } = promotionInputs(env.dir);
  assert.throws(() => runPromoteCommand(null, argv, { authority: { mode: env.mode } }), (error) => {
    assert.equal(error.exitCode, 4);
    assert.match(error.message, /AUTHORITY_DECISION_REQUIRED/);
    assert.match(error.message, /huqan-authority request terfi --workspace 'default'/);
    return true;
  });

  const requested = await request('terfi', { argsJson: JSON.stringify({ argv, digests }) }, env.deps);
  assert.equal(requested.code, 0, JSON.stringify(requested.report));
  await operatorDecides(env, requested.report.approvalId);
  const applied = await apply(requested.report.approvalId, {}, env.deps);
  assert.equal(applied.code, 0, JSON.stringify(applied.report));
  assert.equal(applied.report.executed, true);
});

test('terfi refuses an applied decision once an input file changed', async (t) => {
  const env = await setup(t);
  const { runPromoteCommand } = require('../lib/cli-promote');
  const { argv, digests } = promotionInputs(env.dir);
  const requested = await request('terfi', { argsJson: JSON.stringify({ argv, digests }) }, env.deps);
  await operatorDecides(env, requested.report.approvalId);
  fs.appendFileSync(path.join(env.dir, 'gozlem.json'), ' ');
  const applied = await apply(requested.report.approvalId, {}, env.deps);
  assert.equal(applied.code, 2);
  assert.equal(applied.report.executed, false);
  assert.equal(applied.report.error, 'EXECUTION_REFUSED');
  assert.match(applied.report.message, /AUTHORITY_DECISION_INVALID/);
  assert.equal(typeof runPromoteCommand, 'function');
});

test('an applied activation stops verifying once its registration expires', async (t) => {
  const env = await setup(t);
  const requested = await request('huqan.autonomy_activation', { workspaceId: 'ws-1', argsJson: '{}' }, env.deps);
  const { approvalId, expiresAt } = requested.report;
  await operatorDecides(env, approvalId);
  assert.equal((await apply(approvalId, {}, env.deps)).code, 0);
  const at = (instant) => verifyAutonomyActivation({ mode: env.mode, approvalId, workspaceId: 'ws-1', now: () => instant });
  assert.equal((await at(Date.parse(expiresAt) - 1)).ok, true);
  assert.equal((await at(Date.parse(expiresAt))).code, 'AUTHORITY_DECISION_EXPIRED');
});

test('a terfi whose loop refuses is not reported or recorded as executed', async (t) => {
  const env = await setup(t);
  // A candidate costlier than its baseline fails the canary: the loop refuses without throwing.
  const { argv, digests } = promotionInputs(env.dir, { candidateCost: 50 });
  const requested = await request('terfi', { argsJson: JSON.stringify({ argv, digests }) }, env.deps);
  await operatorDecides(env, requested.report.approvalId);
  const applied = await apply(requested.report.approvalId, {}, env.deps);
  assert.equal(applied.code, 2);
  assert.equal(applied.report.executed, false);
  assert.equal(applied.report.error, 'PROMOTION_NOT_MOVED');
  const outcome = env.ledger.all().find(e => e.type === 'approval.outcome' && e.body.approvalId === requested.report.approvalId);
  assert.equal(outcome.body.status, 'failed');
});

test('apply says so when the authority does not record the outcome of an action that ran', async (t) => {
  const env = await setup(t);
  const requested = await request('huqan.autonomy_activation', { workspaceId: 'ws-1', argsJson: '{}' }, env.deps);
  await operatorDecides(env, requested.report.approvalId);
  const flaky = ({ pin }) => ({ ...createAuthorityClient({ pin }), recordOutcome: async () => ({ status: 503, body: { code: 'LEDGER_CORRUPT' } }) });
  const applied = await apply(requested.report.approvalId, {}, { ...env.deps, createClient: flaky });
  assert.equal(applied.code, 2);
  assert.equal(applied.report.executed, true);
  assert.equal(applied.report.outcomeRecorded, false);
  assert.equal(applied.report.outcomeError, 'LEDGER_CORRUPT');
});

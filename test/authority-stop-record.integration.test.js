'use strict';

// #3892: a stop is recorded with the approval authority after it holds
// locally, and `huqan audit --authority` reports a recorded stop that left the
// local ledger, or a local lift no authority decision covers. The brake never
// waits on the authority: an authority that is down or refuses costs the
// record, not the stop.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAuthorityState, openAuthorityState } = require('../lib/authority/state-store');
const { openLedgerStore } = require('../lib/authority/ledger-store');
const { createAuthorityService } = require('../lib/authority/authority-service');
const { createAuthorityServer } = require('../lib/authority/http-server');
const { parseAuthorityPin } = require('../lib/authority/authority-pin');
const { createAuthorityClient } = require('../lib/authority/authority-client');
const { keyIdFor } = require('../lib/authority/decision-envelope');
const { sealDecisionRequest } = require('../lib/authority/sealed-request');
const { totpAt, TOTP_STEP_SECONDS } = require('../lib/authority/totp');
const { createEmergencyStop } = require('../lib/emergency-stop');
const { readLedgerEntries } = require('../lib/emergency-stop-chain');
const { compareStopsWithAuthority } = require('../lib/emergency-stop-detection');
const { fetchAuthorityLedger, recordAuthorityStop } = require('../lib/mcp/authority-ledger-provider');
const { runCliArgv } = require('../lib/cli-workflow-adapter');
const { request, apply } = require('../bin/huqan-authority');

const LEGACY = () => ({ mode: 'legacy', reason: 'no_pin' });

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-authority-stops-'));
  const isolated = { HUQAN_EMERGENCY_STOP_DIR: path.join(dir, 'stops') };
  const saved = Object.fromEntries(Object.keys(isolated).map(key => [key, process.env[key]]));
  Object.assign(process.env, isolated);
  const created = createAuthorityState({ dir: path.join(dir, 'state') });
  const state = openAuthorityState({ dir: path.join(dir, 'state') });
  const ledger = openLedgerStore({ file: path.join(dir, 'ledger.jsonl') });
  const httpServer = createAuthorityServer({ service: createAuthorityService({ ledger, state }), signingKey: state.signingKey });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const pin = parseAuthorityPin(JSON.stringify({ v: 'huqan.authority.pin.v1', port: httpServer.address().port,
    keyId: keyIdFor(created.signingPublicKeyPem), signingKey: created.signingPublicKeyPem,
    sealingKey: created.sealingPublicKeyPem })).pin;
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
  const stopsDir = isolated.HUQAN_EMERGENCY_STOP_DIR;
  return {
    created, ledger, mode, stopsDir,
    deps: { resolveMode: () => mode, loadConsumeKey: () => consumeKey },
    client: createAuthorityClient({ pin }),
    stops: createEmergencyStop({ directory: stopsDir, resolveAuthorityMode: () => mode }),
    record: entry => recordAuthorityStop(entry, { resolveMode: () => mode }),
  };
}

async function operatorDecides(env, approvalId) {
  const shown = await env.client.show(approvalId);
  const totp = totpAt(env.created.totpSecret, Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS));
  const sealed = sealDecisionRequest({ approvalId, actionHash: shown.body.approval.actionHash, decision: 'approved',
    reason: 'checked', totp }, env.created.sealingPublicKeyPem);
  assert.equal((await env.client.decide(approvalId, sealed)).status, 200);
}

async function detect(env, workspaceId) {
  const fetched = await fetchAuthorityLedger({ workspaceId }, { resolveMode: () => env.mode });
  return compareStopsWithAuthority({ authorityEntries: fetched.entries, localEntries: readLedgerEntries(env.stopsDir),
    workspaceId, truncated: fetched.truncated });
}

const stopEntries = env => env.ledger.all().filter(entry => entry.type === 'emergency.stopped');

test('a stop is recorded under its local entry hash, once', async (t) => {
  const env = await setup(t);
  const stopped = env.stops.stop({ scope: 'agent', workspaceId: 'ws-1', agentId: 'a1', reason: 'contain', actor: 'operator:cli' });
  const recorded = await env.record(stopped.ledgerEntry);
  assert.equal(recorded.recorded, true);
  const [entry] = stopEntries(env);
  assert.equal(entry.body.localHash, stopped.ledgerEntry.hash);
  assert.deepEqual([entry.body.workspaceId, entry.body.scope, entry.body.agentId, entry.body.actor],
    ['ws-1', 'agent', 'a1', 'operator:cli']);

  assert.equal((await env.record(stopped.ledgerEntry)).recorded, true, 'a retry is answered');
  assert.equal(stopEntries(env).length, 1, 'and records nothing new');
  assert.deepEqual(await detect(env, 'ws-1'), [], 'both ledgers agree');
});

test('legacy mode records nothing and an unreachable authority never undoes the stop', async (t) => {
  const env = await setup(t);
  const stopped = env.stops.stop({ scope: 'workspace', workspaceId: 'ws-2', reason: 'incident', actor: 'operator:cli' });
  assert.deepEqual(await recordAuthorityStop(stopped.ledgerEntry, { resolveMode: LEGACY }), { recorded: false, reason: 'legacy' });

  const closedPin = { ...env.mode.pin, port: 1 };
  const down = await recordAuthorityStop(stopped.ledgerEntry, { resolveMode: () => ({ ...env.mode, pin: closedPin }) });
  assert.deepEqual(down, { recorded: false, reason: 'AUTHORITY_UNAVAILABLE' });
  assert.equal(env.stops.check({ workspaceId: 'ws-2' }).stopped, true);
  assert.equal(stopEntries(env).length, 0);
});

test('the authority refuses a malformed stop record', async (t) => {
  const env = await setup(t);
  const good = { workspaceId: 'w', scope: 'workspace', agentId: null, reason: '', actor: 'operator:cli',
    localSeq: 0, localHash: 'a'.repeat(64), stoppedAt: new Date().toISOString() };
  for (const bad of [{ scope: 'agent' }, { agentId: 'a1' }, { localHash: 'xyz' }, { localSeq: -1 }, { actor: '' },
    { workspaceId: 'w\u0000' }, { stoppedAt: 'yesterday' }]) {
    const answer = await env.client.recordStop({ ...good, ...bad });
    assert.deepEqual([answer.status, answer.body.code], [400, 'INVALID'], JSON.stringify(bad));
  }
  assert.equal((await env.client.recordStop(good)).status, 201);
});

test('the CLI stop reports the record and still exits completed when the authority is down', async (t) => {
  const env = await setup(t);
  const out = [];
  const run = (deps, workspaceId) => runCliArgv(['stop', '--scope', 'workspace', '--workspace', workspaceId, '--reason', 'x', '--json'],
    { stdout: value => out.push(value), stderr: value => out.push(value) }, { emergencyStop: env.stops, ...deps });

  assert.equal((await run({ recordAuthorityStop: env.record }, 'ws-3')).exitCode, 0);
  assert.equal(JSON.parse(out.pop()).data.authorityRecord.recorded, true);
  assert.equal(stopEntries(env).length, 1);

  const down = entry => recordAuthorityStop(entry, { resolveMode: () => ({ ...env.mode, pin: { ...env.mode.pin, port: 1 } }) });
  assert.equal((await run({ recordAuthorityStop: down }, 'ws-4')).exitCode, 0);
  assert.deepEqual(JSON.parse(out.pop()).data.authorityRecord, { recorded: false, reason: 'AUTHORITY_UNAVAILABLE' });
  assert.equal(env.stops.check({ workspaceId: 'ws-4' }).stopped, true);

  assert.equal((await run({ recordAuthorityStop: () => ({ recorded: false, reason: 'legacy' }) }, 'ws-5')).exitCode, 0);
  assert.equal('authorityRecord' in JSON.parse(out.pop()).data, false, 'legacy mode adds nothing to the output');
});

test('the HTTP stop reports the record, and a recorder that throws still leaves a completed stop', async (t) => {
  const { createEmergencyStopRoutes, EMERGENCY_STOP_PATHNAME, OPERATOR_CAPABILITY_HEADER } = require('../lib/http/emergency-stop-routes');
  const { createMcpOperatorCapability } = require('../lib/mcp-operator-capability');
  const { operatorCapabilityBinding } = require('../lib/mcp/operator-authorization');
  const { changeArguments } = require('../lib/emergency-stop');
  const env = await setup(t);
  const post = async (recordAuthorityStop, body) => {
    const routes = createEmergencyStopRoutes({ operatorToken: 'op', emergencyStop: env.stops, capabilityNonces: new Map(),
      recordAuthorityStop, parseJsonRequest: async req => req.body,
      writeJson: (_req, res, status, payload) => { res.status = status; res.body = payload; } });
    const capability = createMcpOperatorCapability({ secret: 'op', ...operatorCapabilityBinding('huqan.emergency_stop', changeArguments(body)) });
    const res = {};
    await routes.route({ method: 'POST', body, headers: { [OPERATOR_CAPABILITY_HEADER]: capability } }, res,
      new URL(`http://127.0.0.1${EMERGENCY_STOP_PATHNAME}`));
    return res;
  };
  const recorded = await post(env.record, { action: 'stop', scope: 'workspace', workspaceId: 'ws-9', reason: 'x' });
  assert.equal(recorded.status, 200);
  assert.equal(recorded.body.data.authorityRecord.recorded, true);
  const thrown = await post(() => { throw new Error('boom'); }, { action: 'stop', scope: 'workspace', workspaceId: 'ws-10', reason: 'x' });
  assert.equal(thrown.status, 200);
  assert.deepEqual(thrown.body.data.authorityRecord, { recorded: false, reason: 'AUTHORITY_RECORD_FAILED' });
  assert.equal(env.stops.check({ workspaceId: 'ws-10' }).stopped, true);
});

test('the MCP stop hands its new ledger entry to the recorder, and a repeated stop does not', async (t) => {
  const { callTool, createServer } = require('../mcpServer');
  const { createMcpOperatorCapability } = require('../lib/mcp-operator-capability');
  const { operatorCapabilityBinding } = require('../lib/mcp/operator-authorization');
  const env = await setup(t);
  const server = createServer({ kernel: {} });
  t.after(() => { server.kernel.graph?.close?.(); server.approvalStore?.close?.(); });
  const seen = [];
  const run = (args) => callTool(server.kernel, { name: 'huqan.emergency_stop', arguments: args,
    operatorCapability: createMcpOperatorCapability({ secret: 'op', ...operatorCapabilityBinding('huqan.emergency_stop', args) }) },
  { operatorSecret: 'op', operatorCapabilityNonces: new Map(), emergencyStop: env.stops, recordAuthorityStop: entry => seen.push(entry) });
  const args = { action: 'stop', scope: 'agent', workspaceId: 'ws-6', agentId: 'a2', reason: 'contain' };
  assert.equal(run(args).ok, true);
  assert.equal(run(args).ok, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].action, 'stop');
  assert.equal(seen[0].agentId, 'a2');
});

test('audit reports a recorded stop that the local ledger no longer holds', async (t) => {
  const env = await setup(t);
  const stopped = env.stops.stop({ scope: 'workspace', workspaceId: 'ws-7', reason: 'incident', actor: 'operator:cli' });
  await env.record(stopped.ledgerEntry);
  // A same-user agent rewrites its own ledger: the empty chain still verifies.
  fs.rmSync(env.stopsDir, { recursive: true, force: true });
  assert.equal(env.stops.check({ workspaceId: 'ws-7' }).stopped, false, 'locally the stop is gone');
  const findings = await detect(env, 'ws-7');
  assert.deepEqual(findings.map(f => [f.code, f.localHash]), [['STOP_MISSING_LOCALLY', stopped.ledgerEntry.hash]]);
});

test('audit reports a lift written past the guard, and not one the operator decided', async (t) => {
  const env = await setup(t);
  env.stops.stop({ scope: 'workspace', workspaceId: 'ws-8', reason: 'incident', actor: 'operator:cli' });
  const requested = await request('huqan.emergency_stop', { workspaceId: 'ws-8',
    argsJson: JSON.stringify({ action: 'lift', scope: 'workspace', workspaceId: 'ws-8', agentId: '', reason: 'closed' }) }, env.deps);
  await operatorDecides(env, requested.report.approvalId);
  assert.equal((await apply(requested.report.approvalId, {}, env.deps)).code, 0);
  assert.deepEqual(await detect(env, 'ws-8'), [], 'a decided lift is no finding');

  // The agent stops nothing new but lifts a second stop with the guard skipped.
  env.stops.stop({ scope: 'workspace', workspaceId: 'ws-8', reason: 'again', actor: 'operator:cli' });
  const bypass = createEmergencyStop({ directory: env.stopsDir, resolveAuthorityMode: LEGACY });
  assert.equal(bypass.lift({ scope: 'workspace', workspaceId: 'ws-8', reason: 'quiet', actor: 'operator:cli' }).lifted, true);
  const findings = await detect(env, 'ws-8');
  assert.deepEqual(findings.map(f => [f.code, f.localLifts, f.consumedLifts]), [['LIFT_WITHOUT_AUTHORITY', 2, 1]]);
});

test('detection reports an unreadable local ledger instead of calling every stop missing', () => {
  const authorityEntries = [{ seq: 0, at: new Date().toISOString(), type: 'emergency.stopped',
    body: { workspaceId: 'w', scope: 'workspace', agentId: null, localSeq: 0, localHash: 'b'.repeat(64) } }];
  for (const localEntries of [null, [{ __unreadable: true }], [{ __corrupt: true }]]) {
    assert.deepEqual(compareStopsWithAuthority({ authorityEntries, localEntries, workspaceId: 'w', truncated: false })
      .map(f => f.code), ['LOCAL_STOP_LEDGER_UNREADABLE']);
  }
  assert.deepEqual(compareStopsWithAuthority({ authorityEntries: [], localEntries: null, workspaceId: 'w', truncated: false }), []);
});

test('audit --authority carries the stop findings into its detection section', () => {
  const { buildAuthoritySection } = require('../lib/cli-audit');
  const at = new Date().toISOString();
  const hash = 'c'.repeat(64);
  const ledger = { mode: 'service', corrupt: false, truncated: false, receipts: {},
    entries: [{ seq: 0, at, type: 'emergency.stopped', body: { workspaceId: 'default', scope: 'workspace', agentId: null, localSeq: 0, localHash: hash } }] };
  const missing = buildAuthoritySection({ workspaceId: 'default', getApprovalStore: () => null, ledger, localStopEntries: [] });
  assert.equal(missing.status, 'fail');
  assert.deepEqual(missing.evidence.findings.map(f => f.code), ['STOP_MISSING_LOCALLY']);
  const held = buildAuthoritySection({ workspaceId: 'default', getApprovalStore: () => null, ledger,
    localStopEntries: [{ seq: 0, hash, action: 'stop', scope: 'workspace', workspaceId: 'default', agentId: null, createdAt: at }] });
  assert.deepEqual(held.evidence.findings, []);
});

test('a second report under a recorded hash with a different claim is a conflict', async (t) => {
  const env = await setup(t);
  const stopped = env.stops.stop({ scope: 'workspace', workspaceId: 'ws-11', reason: 'incident', actor: 'operator:cli' });
  assert.equal((await env.record(stopped.ledgerEntry)).recorded, true);
  const conflicting = await env.client.recordStop({ workspaceId: 'ws-12', scope: 'workspace', agentId: null, reason: 'incident',
    actor: 'operator:cli', localSeq: stopped.ledgerEntry.seq, localHash: stopped.ledgerEntry.hash, stoppedAt: stopped.ledgerEntry.createdAt });
  assert.deepEqual([conflicting.status, conflicting.body.code], [409, 'CONFLICT']);
  assert.equal(stopEntries(env).length, 1);
});

test('a lift with no decision is reported even when the authority holds no stop records', () => {
  const at = '2026-10-15T10:00:00.000Z';
  const unrelated = [{ seq: 0, at, type: 'approval.registered', body: { approvalId: 'apr_1', tool: 'huqan.learn', workspaceId: 'w' } }];
  // The stop predates the authority; the lift after its first entry needed a decision.
  const local = [
    { seq: 0, hash: 'd'.repeat(64), action: 'stop', scope: 'workspace', workspaceId: 'w', agentId: null, createdAt: '2026-10-15T09:00:00.000Z' },
    { seq: 1, hash: 'e'.repeat(64), action: 'lift', scope: 'workspace', workspaceId: 'w', agentId: null, createdAt: '2026-10-15T11:00:00.000Z' },
  ];
  assert.deepEqual(compareStopsWithAuthority({ authorityEntries: unrelated, localEntries: local, workspaceId: 'w', truncated: false })
    .map(f => f.code), ['LIFT_WITHOUT_AUTHORITY']);
  assert.deepEqual(compareStopsWithAuthority({ authorityEntries: unrelated, localEntries: local, workspaceId: 'w', truncated: true }), [],
    'a cut window cannot count lifts');
  assert.deepEqual(compareStopsWithAuthority({ authorityEntries: unrelated, localEntries: null, workspaceId: 'w', truncated: false }), [],
    'nothing about stops and an unreadable ledger is no finding');
});

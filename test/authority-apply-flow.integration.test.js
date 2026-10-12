'use strict';

// ADR-016 end to end: a pending local approval is registered with a real
// authority service, decided by the operator's sealed TOTP code, applied by
// the runtime, and recorded in the authority's ledger -- once.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { callTool, createServer } = require('../mcpServer');
const { createAuthorityState, openAuthorityState } = require('../lib/authority/state-store');
const { openLedgerStore } = require('../lib/authority/ledger-store');
const { createAuthorityService } = require('../lib/authority/authority-service');
const { createAuthorityServer } = require('../lib/authority/http-server');
const { parseAuthorityPin } = require('../lib/authority/authority-pin');
const { createAuthorityClient } = require('../lib/authority/authority-client');
const { keyIdFor } = require('../lib/authority/decision-envelope');
const { sealDecisionRequest } = require('../lib/authority/sealed-request');
const { totpAt, TOTP_STEP_SECONDS } = require('../lib/authority/totp');
const { sync, apply } = require('../bin/huqan-authority');

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-authority-flow-'));
  const saved = { mem: process.env.HUQAN_MEMORY_PATH, db: process.env.HUQAN_DB_PATH };
  process.env.HUQAN_MEMORY_PATH = path.join(dir, 'memory.json');
  process.env.HUQAN_DB_PATH = path.join(dir, 'memory.db');
  const created = createAuthorityState({ dir: path.join(dir, 'state') });
  const state = openAuthorityState({ dir: path.join(dir, 'state') });
  const ledger = openLedgerStore({ file: path.join(dir, 'ledger.jsonl') });
  const httpServer = createAuthorityServer({ service: createAuthorityService({ ledger, state }), signingKey: state.signingKey });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const pin = parseAuthorityPin(JSON.stringify({ v: 'huqan.authority.pin.v1', port: httpServer.address().port,
    keyId: keyIdFor(created.signingPublicKeyPem), signingKey: created.signingPublicKeyPem, sealingKey: created.sealingPublicKeyPem })).pin;
  t.after(() => new Promise((resolve) => httpServer.close(() => {
    for (const [key, value] of [['HUQAN_MEMORY_PATH', saved.mem], ['HUQAN_DB_PATH', saved.db]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    resolve();
  })));
  const consumeKey = crypto.randomBytes(32);
  const deps = { resolveMode: () => ({ mode: 'service', boundary: 'os-service', pin }), loadConsumeKey: () => consumeKey };
  return { created, pin, ledger, deps };
}

function queueLocally(text) {
  const server = createServer();
  try {
    const queued = callTool(server.kernel, { name: 'huqan.learn', arguments: { text } }, { approvalStore: server.approvalStore });
    assert.equal(queued.approval.status, 'pending');
    return queued.approval.id;
  } finally {
    server.kernel.graph?.close?.();
    server.approvalStore?.close?.();
  }
}

async function operatorDecides(env, approvalId, decision = 'approved') {
  const client = createAuthorityClient({ pin: env.pin });
  const shown = await client.show(approvalId);
  const totp = totpAt(env.created.totpSecret, Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS));
  const sealed = sealDecisionRequest({ approvalId, actionHash: shown.body.approval.actionHash, decision, reason: 'checked', totp },
    env.created.sealingPublicKeyPem);
  return client.decide(approvalId, sealed);
}

test('register, decide, apply: the action runs once and the ledger holds every step', async (t) => {
  const env = await setup(t);
  const approvalId = queueLocally('authority flow sentinel hayvandir');
  const synced = await sync({}, env.deps);
  assert.equal(synced.code, 0, JSON.stringify(synced.report));
  assert.deepEqual(synced.report.results.map(r => r.approvalId), [approvalId]);

  const waiting = await apply(approvalId, {}, env.deps);
  assert.equal(waiting.code, 3, 'nothing runs before the operator decides');

  const decided = await operatorDecides(env, approvalId);
  assert.equal(decided.status, 200);

  const applied = await apply(approvalId, {}, env.deps);
  assert.equal(applied.code, 0, JSON.stringify(applied.report));
  assert.equal(applied.report.executed, true);

  const again = await apply(approvalId, {}, env.deps);
  assert.deepEqual([again.code, again.report.alreadyFinal], [0, 'approved'], 'a second apply changes nothing');

  const types = env.ledger.all().map(entry => entry.type);
  assert.deepEqual(types, ['approval.registered', 'approval.decided', 'approval.consumed', 'approval.outcome']);
  assert.equal(env.ledger.all()[3].body.status, 'executed');
});

test('an operator rejection is applied without consuming anything', async (t) => {
  const env = await setup(t);
  const approvalId = queueLocally('authority flow rejected sentinel hayvandir');
  await sync({}, env.deps);
  await operatorDecides(env, approvalId, 'rejected');
  const applied = await apply(approvalId, {}, env.deps);
  assert.equal(applied.code, 0, JSON.stringify(applied.report));
  assert.equal(applied.report.decision, 'rejected');
  assert.ok(!env.ledger.all().some(entry => entry.type === 'approval.consumed'));
});

test('without an installed authority, sync and apply refuse instead of acting', async () => {
  for (const run of [() => sync({}, { resolveMode: () => ({ mode: 'legacy', boundary: 'same-user' }) }),
    () => apply('apr_x', {}, { resolveMode: () => ({ mode: 'required_unavailable', reason: 'pin_malformed' }) })]) {
    const result = await run();
    assert.equal(result.code, 2);
  }
});

test('apply takes the workspace from the signed envelope and refuses a conflicting --workspace', async (t) => {
  const env = await setup(t);
  const approvalId = queueLocally('authority flow workspace sentinel hayvandir');
  await sync({}, env.deps);
  await operatorDecides(env, approvalId);
  const conflicting = await apply(approvalId, { workspaceId: 'someone-else' }, env.deps);
  assert.deepEqual([conflicting.code, conflicting.report.error], [2, 'WORKSPACE_MISMATCH']);
  assert.ok(!env.ledger.all().some(entry => entry.type === 'approval.consumed'), 'nothing was spent at the authority');
  const applied = await apply(approvalId, {}, env.deps);
  assert.equal(applied.code, 0, JSON.stringify(applied.report));
});

test('a row with a malformed stored expiry is reported, not thrown', () => {
  const { buildRegistration } = require('../lib/authority/registration-payload');
  const body = buildRegistration({ id: 'apr_bad', tool: 'huqan.learn', input: '{}', createdAt: new Date().toISOString(),
    context: { expiresAt: 'not a date' } }, { consumeKey: crypto.randomBytes(32), ttlMs: 60000 });
  assert.equal(body, null);
});

test('a crash after consuming is recovered: apply again uses the recorded consumption and runs once', async (t) => {
  const env = await setup(t);
  const approvalId = queueLocally('authority flow crash sentinel hayvandir');
  await sync({}, env.deps);
  await operatorDecides(env, approvalId);
  const client = createAuthorityClient({ pin: env.pin });
  const decision = await client.getDecision(approvalId);
  const { consumeProofFor } = require('../lib/authority/registration-payload');
  const consumed = await client.consume(approvalId, { actionHash: decision.body.envelope.payload.actionHash,
    consumeProof: consumeProofFor(env.deps.loadConsumeKey(), approvalId) });
  assert.equal(consumed.status, 200, 'the first apply got this far and then died');
  const applied = await apply(approvalId, {}, env.deps);
  assert.equal(applied.code, 0, JSON.stringify(applied.report));
  assert.equal(applied.report.executed, true);
  assert.equal(env.ledger.all().filter(entry => entry.type === 'approval.consumed').length, 1);
});

test('a decision that does not match the local row is refused before anything is consumed', async (t) => {
  const env = await setup(t);
  const approvalId = queueLocally('authority flow drift sentinel hayvandir');
  await sync({}, env.deps);
  await operatorDecides(env, approvalId);
  const server = createServer();
  try {
    const row = server.approvalStore.getToolApprovalById(approvalId);
    const context = JSON.parse(row.context_json || '{}');
    context.args = { ...(context.args || {}), text: 'something the operator never saw' };
    server.approvalStore.db.prepare('UPDATE tool_approvals SET context_json = ? WHERE id = ?').run(JSON.stringify(context), approvalId);
  } finally {
    server.kernel.graph?.close?.();
    server.approvalStore?.close?.();
  }
  const applied = await apply(approvalId, {}, env.deps);
  assert.deepEqual([applied.code, applied.report.error], [2, 'AUTHORITY_DECISION_INVALID']);
  assert.ok(!env.ledger.all().some(entry => entry.type === 'approval.consumed'), 'nothing was spent at the authority');
});

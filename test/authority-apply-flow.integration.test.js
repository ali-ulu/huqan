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
const { verifyApprovalDecisionAttestation } = require('../lib/authority/decision-attestation');
const { sealDecisionRequest } = require('../lib/authority/sealed-request');
const { totpAt, TOTP_STEP_SECONDS } = require('../lib/authority/totp');
const { sync, apply, request } = require('../bin/huqan-authority');
const { execFileSync } = require('node:child_process');
const CLI = require('../cli');
const { runCliCoder } = require('../lib/cli-coder');
const { openJournalConnection } = require('../lib/experience/journal-connection');
const { createExperienceJournal } = require('../lib/experience/journal');
const { buildLearningProposal } = require('../lib/experience/learning-intake');
const { qualify } = require('../lib/experience/compiler');
const { readCoderPromotionReceipt } = require('../lib/experience/coder-promotion-receipt');

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-authority-flow-'));
  const saved = { mem: process.env.HUQAN_MEMORY_PATH, db: process.env.HUQAN_DB_PATH };
  process.env.HUQAN_MEMORY_PATH = path.join(dir, 'memory.json');
  process.env.HUQAN_DB_PATH = path.join(dir, 'memory.db');
  const created = createAuthorityState({ dir: path.join(dir, 'state') });
  const state = openAuthorityState({ dir: path.join(dir, 'state'), operatorId: 'operator-1' });
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
  return { created, pin, ledger, deps, dir };
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
  assert.equal(applied.report.outcomeRecorded, true);
  assert.equal(applied.report.decisionAttestationStored, true);

  const local = createServer();
  try {
    const row = local.approvalStore.getToolApprovalById(approvalId);
    const proof = row.context.decisionAttestation;
    assert.ok(proof, 'the portable decision attestation is persisted with the approval');
    const verified = verifyApprovalDecisionAttestation(proof, {
      publicKey: env.pin.signingKey,
      receipt: row.context.receipt,
      expected: { approvalId, workspaceId: 'default', tool: 'huqan.learn', decision: 'approved' },
      expectedOutcomeStatus: 'executed',
    });
    assert.equal(verified.ok, true, verified.code);
    assert.equal(verified.decision.operatorId, 'operator-1');
  } finally {
    local.kernel.graph?.close?.();
    local.approvalStore?.close?.();
  }

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

test('approve, withdraw, apply: the action is refused at the authority and never runs', async (t) => {
  const env = await setup(t);
  const approvalId = queueLocally('authority flow withdrawn sentinel hayvandir');
  await sync({}, env.deps);
  await operatorDecides(env, approvalId);
  const client = createAuthorityClient({ pin: env.pin });
  const shown = await client.show(approvalId);
  const nextStep = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS) + 1;
  const sealed = sealDecisionRequest({ approvalId, actionHash: shown.body.approval.actionHash, decision: 'withdrawn',
    reason: 'changed my mind', totp: totpAt(env.created.totpSecret, nextStep) }, env.created.sealingPublicKeyPem);
  const withdrawn = await client.withdraw(approvalId, sealed);
  assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));

  const applied = await apply(approvalId, {}, env.deps);
  assert.deepEqual([applied.code, applied.report.error], [2, 'WITHDRAWN']);
  const types = env.ledger.all().map(entry => entry.type);
  assert.deepEqual(types, ['approval.registered', 'approval.decided', 'approval.withdrawn']);

  const server = createServer();
  try {
    assert.equal(server.approvalStore.getToolApprovalById(approvalId).status, 'pending', 'the local action did not run');
  } finally {
    server.kernel.graph?.close?.();
    server.approvalStore?.close?.();
  }
});

test('authority promotion binds a real native procedure and recovers its journal without rerunning the action', async t => {
  const env = await setup(t), root = path.join(env.dir, 'repo'), journalDir = path.join(env.dir, 'journal');
  fs.mkdirSync(root); fs.mkdirSync(journalDir);
  const db = path.join(journalDir, 'experience.db'), parked = path.join(env.dir, 'journal-held');
  const git = args => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
  git(['init', '-q', '-b', 'feature/promotion']);
  git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'source old');
  git(['add', 'a.txt']); git(['commit', '-qm', 'source']);
  const task = path.join(env.dir, 'task.json');
  fs.writeFileSync(task, JSON.stringify({ id: 'replace', level: 'l0', allowedPaths: ['a.txt'],
    operation: { type: 'replace_text', path: 'a.txt', find: 'old', replace: 'new' } }));
  assert.equal(runCliCoder([task, '--root', root, '--journal', db, '--run-id', 'source'], { json: true }).status, 'completed');
  const store = openJournalConnection({ dbPath: db, readOnly: true });
  let artifacts;
  try {
    const journal = createExperienceJournal({ store, readOnly: true });
    artifacts = [0, 1].map(parentVersion => {
      const proposal = buildLearningProposal(journal, { runId: 'source', workspaceId: 'default', parentVersion,
        params: { path: 'a.txt', oldText: 'old', newText: 'new' } });
      assert.equal(proposal.ok, true);
      const qualification = qualify({ procedure: proposal.procedure, inputs: ['separate old'], observe: value => value,
        apply: (procedure, value) => ({ sites: value.split(procedure.params.oldText).length - 1,
          after: value.replace(procedure.params.oldText, () => procedure.params.newText) }) });
      assert.equal(qualification.qualified, true);
      return { procedure: proposal.procedure, qualification,
        sourceRunHashes: [{ runId: 'source', sourceHash: proposal.sourceHash }] };
    });
  } finally { store.close(); }
  const startAt = Date.now() - 60 * 60 * 1000;
  const runs = (prefix, cost) => Array.from({ length: 12 }, (_, i) => ({ occurredAt: startAt + i * 60000,
    learningEligibility: 'positive_procedure', executionCost: cost, verificationCost: 1, canaryOverheadCost: 0,
    eventId: `${prefix}-e${i}`, runId: `${prefix}-r${i}` }));
  const contents = { aday: artifacts[1], bagli: artifacts[0],
    deneme: { candidateRuns: runs('candidate', 5), baselineWindowRuns: runs('baseline', 10), startAt },
    gozlem: { currentEvents: runs('observed', 5) } };
  const digests = {}, argv = [];
  for (const [name, value] of Object.entries(contents)) {
    const file = path.join(env.dir, `${name}.json`), text = JSON.stringify(value);
    fs.writeFileSync(file, text); digests[name] = crypto.createHash('sha256').update(text).digest('hex');
    argv.push(`--${name}`, file);
  }
  argv.push('--capability', 'replace', '--onaylayan', os.userInfo().username, '--karar', 'approved', '--journal', db);
  const registered = await request('terfi', { argsJson: JSON.stringify({ argv, digests }) }, env.deps);
  assert.equal(registered.code, 0, JSON.stringify(registered.report));
  const approvalId = registered.report.approvalId;
  assert.equal((await operatorDecides(env, approvalId)).status, 200);
  const execute = CLI.prototype.execute; let executions = 0;
  CLI.prototype.execute = function (command, ...args) { if (command === 'terfi') executions++; return execute.call(this, command, ...args); };
  t.after(() => { CLI.prototype.execute = execute; });
  const client = createAuthorityClient({ pin: env.pin });
  const interrupted = await apply(approvalId, {}, { ...env.deps, createClient: () => ({ ...client,
    recordOutcome: async (...args) => { const result = await client.recordOutcome(...args); fs.renameSync(journalDir, parked); return result; } }) });
  assert.equal(interrupted.code, 2, JSON.stringify(interrupted.report));
  assert.equal(interrupted.report.outcomeRecorded, true, JSON.stringify(interrupted.report));
  assert.equal(interrupted.report.receiptPending, true);
  assert.equal(executions, 1);
  fs.renameSync(parked, journalDir);
  const candidateFile = path.join(env.dir, 'aday.json'), candidateText = fs.readFileSync(candidateFile, 'utf8');
  fs.writeFileSync(candidateFile, `${candidateText} `);
  const changedInput = await apply(approvalId, {}, env.deps);
  assert.equal(changedInput.code, 2);
  assert.equal(changedInput.report.receiptError, 'PROMOTION_INPUT_BINDING_MISMATCH');
  assert.equal(executions, 1);
  fs.writeFileSync(candidateFile, candidateText);
  const recovered = await apply(approvalId, {}, env.deps);
  assert.equal(recovered.code, 0, JSON.stringify(recovered.report));
  assert.equal(recovered.report.promotionReceiptStored, true);
  assert.equal(recovered.report.executed, false);
  assert.equal(executions, 1, 'recovery must not execute terfi again');
  const reopened = openJournalConnection({ dbPath: db, readOnly: true });
  try {
    const receipt = readCoderPromotionReceipt({ journal: createExperienceJournal({ store: reopened, readOnly: true }),
      approvalId, workspaceId: 'default', publicKey: env.pin.signingKey });
    assert.equal(receipt.ok, true);
    assert.equal(receipt.receipt.nextProcedure.hash, artifacts[1].procedure.hash);
    assert.equal(receipt.trusted, false);
  } finally { reopened.close(); }
});

test('a consumed approval cannot be withdrawn through the client', async (t) => {
  const env = await setup(t);
  const approvalId = queueLocally('authority flow consumed sentinel hayvandir');
  await sync({}, env.deps);
  await operatorDecides(env, approvalId);
  assert.equal((await apply(approvalId, {}, env.deps)).code, 0);
  const client = createAuthorityClient({ pin: env.pin });
  const shown = await client.show(approvalId);
  const sealed = sealDecisionRequest({ approvalId, actionHash: shown.body.approval.actionHash, decision: 'withdrawn', reason: '',
    totp: totpAt(env.created.totpSecret, Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS) + 1) }, env.created.sealingPublicKeyPem);
  const refused = await client.withdraw(approvalId, sealed);
  assert.deepEqual([refused.status, refused.body.code], [409, 'ALREADY_CONSUMED']);
});

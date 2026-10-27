'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createAuthorityState, openAuthorityState } = require('../lib/authority/state-store');
const { openLedgerStore } = require('../lib/authority/ledger-store');
const { createAuthorityService } = require('../lib/authority/authority-service');
const { createAuthorityServer } = require('../lib/authority/http-server');
const { createAuthorityClient } = require('../lib/authority/authority-client');
const { sealDecisionRequest } = require('../lib/authority/sealed-request');
const { totpAt, TOTP_STEP_SECONDS } = require('../lib/authority/totp');
const { canonicalActionHash } = require('../lib/mcp-operator-capability');
const { buildApprovalDecisionAttestation } = require('../lib/authority/decision-attestation');
const { createExperienceJournal } = require('../lib/experience/journal');
const { readSealedRun } = require('../lib/experience/learning-intake');
const { compile } = require('../lib/experience/compiler');
const { buildCoderPromotionReceipt, persistCoderPromotionReceipt } = require('../lib/experience/coder-promotion-receipt');
const { withCoderPromotionAcceptance, consumeCoderPromotionAcceptance } = require('../lib/experience/coder-promotion-acceptance');
const { coderCommand } = require('../lib/cli-approval-commands');

test('promotion flags refuse alternate producers before authority or target execution', () => {
  for (const mode of ['--synthesize', '--initialize-project', '--candidate-file', '--use-memory']) {
    assert.throws(() => coderCommand(null, ['task.json', '--journal', 'journal.db', mode, 'candidate.json',
      '--promotion-approval', 'approval', '--promotion-capability', 'replace'], { throwOnError: true,
      coderLoop: { withCoderPromotionAcceptance() { assert.fail('unsupported producer reached authority'); } } }),
    error => error.exitCode === 4 && /ordinary Coder task/.test(error.message));
  }
});

test('malformed promotion flags refuse before authority access', () => {
  const opts = { throwOnError: true, coderLoop: {
    withCoderPromotionAcceptance() { assert.fail('malformed request reached authority'); },
  } };
  for (const flags of [
    ['--promotion-approval'],
    ['--promotion-capability', 'replace'],
    ['--promotion-approval', 'approval'],
    ['--promotion-approval', '', '--promotion-capability', 'replace'],
    ['--promotion-approval', '--promotion-capability', 'replace'],
    ['--promotion-approval', 'approval', '--promotion-approval', 'again', '--promotion-capability', 'replace'],
    ['--promotion-approval', 'approval', '--promotion-capability', '--invalid'],
  ]) assert.throws(() => coderCommand(null, ['task.json', ...flags], opts),
    error => error.exitCode === 4 && /requires one/.test(error.message));
  for (const prefix of ['verify', 'propose', 'remember', 'create', 'revise'])
    assert.throws(() => coderCommand(null, [prefix, 'task.json', '--promotion-approval', 'approval',
      '--promotion-capability', 'replace'], opts), error => error.exitCode === 4 && /ordinary Coder task/.test(error.message));
});

test('promotion requires both journal and host verifier and preserves ordinary usage errors', () => {
  const flags = ['task.json', '--promotion-approval', 'approval', '--promotion-capability', 'replace'];
  assert.match(coderCommand(null, flags), /requires a journal and its host verifier/);
  assert.match(coderCommand(null, [...flags, '--journal', 'journal.db']), /requires a journal and its host verifier/);
  assert.throws(() => coderCommand(null, flags, { throwOnError: true, coderLoop: {
    withCoderPromotionAcceptance() { assert.fail('missing journal reached authority'); },
  } }), error => error.exitCode === 4);
  assert.throws(() => coderCommand(null), /Usage: coder/);
});

test('promotion preflight receives explicit bindings and preserves refusal exit codes', async () => {
  const args = 'task.json --journal journal.db --promotion-approval approval --promotion-capability replace';
  for (const [workspaceId, exitCode] of [[undefined, undefined], ['ws', 5]]) {
    await assert.rejects(coderCommand(null, args, { throwOnError: true, workspaceId, coderLoop: {
      withCoderPromotionAcceptance(binding) {
        assert.deepEqual(binding, { journalPath: 'journal.db', approvalId: 'approval',
          workspaceId: workspaceId || 'default', capabilityId: 'replace' });
        return Promise.reject(Object.assign(new Error('authority refused'), { exitCode }));
      },
    } }), error => error.message === 'authority refused' && error.exitCode === (exitCode || 4));
  }
});

async function fixture(t, { outcomeStatus = 'executed', partial = false, shownPatch, decisionPatch, padding = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promotion-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const created = createAuthorityState({ dir: path.join(dir, 'state') });
  const state = openAuthorityState({ dir: path.join(dir, 'state'), operatorId: 'operator' });
  const now = Date.parse('2026-10-12T12:00:00Z');
  const ledger = openLedgerStore({ file: path.join(dir, 'ledger.jsonl') });
  const service = createAuthorityService({ state, ledger, now: () => now });
  const args = { argv: ['--capability', 'replace'] };
  const actionHash = canonicalActionHash({ tool: 'terfi', workspaceId: 'ws', approvalId: 'approval', arguments: args });
  const consumeProof = 'runtime-held-consume-proof-0123456789abcdef';
  assert.equal(service.register({ approvalId: 'approval', workspaceId: 'ws', tool: 'terfi', arguments: args,
    actionHash, consumeProofHash: crypto.createHash('sha256').update(consumeProof).digest('hex'), summary: 'promotion',
    expiresAt: '2026-10-12T13:00:00Z' }).status, 201);
  const sealed = sealDecisionRequest({ approvalId: 'approval', actionHash, decision: 'approved', reason: 'ok',
    totp: totpAt(created.totpSecret, Math.floor(now / 1000 / TOTP_STEP_SECONDS)) }, created.sealingPublicKeyPem);
  const decisionEnvelope = service.decide('approval', sealed).body.envelope;
  assert.ok(decisionEnvelope);
  assert.equal(service.consume('approval', { actionHash, consumeProof }).status, 200);
  const journalPath = path.join(dir, 'journal.db');
  const db = new Database(journalPath);
  const journal = createExperienceJournal({ store: { db, withTransaction: fn => db.transaction(fn)() } });
  for (const [eventId, type] of [['start', 'run_started'], ['close', 'run_closed']])
    assert.equal(journal.append({ runId: 'source', workspaceId: 'ws', eventId, type }).ok, true);
  const sources = [{ runId: 'source', sourceHash: readSealedRun(journal, 'source', 'ws').sourceHash }];
  const procedure = newText => compile({ candidate: { status: 'candidate', trace: { sources,
    scope: { workspaceId: 'ws' }, revision: 'fixture' } }, kind: 'replace_text',
  params: { oldText: 'a', newText, path: 'a.txt' }, parentVersion: 1 }).procedure;
  const nextProcedure = procedure('b');
  const receipt = buildCoderPromotionReceipt({ approvalId: 'approval', workspaceId: 'ws', actionHash,
    capabilityId: 'replace', inputArtifactDigests: { candidate: 'b'.repeat(64) }, previousProcedure: procedure('c'),
    nextProcedure, sourceRunHashes: sources, qualification: { ok: true, qualified: true, procedureHash: nextProcedure.hash }, outcome: 'promoted' });
  const recorded = service.recordOutcome('approval', { status: 'executed', receiptId: receipt.receiptId,
    receiptHash: receipt.receiptHash, consumeProof });
  for (let index = 0; index < padding; index++) ledger.append('test.padding', { index }, new Date(now).toISOString());
  const decisionAttestation = buildApprovalDecisionAttestation({ decisionEnvelope,
    outcomeAttestation: recorded.body.attestation }, receipt, { publicKey: created.signingPublicKeyPem });
  const writeJournal = partial ? { ...journal, append: event => event.type === 'run_closed'
    ? { ok: false, code: 'interrupted' } : journal.append(event) } : journal;
  const persisted = persistCoderPromotionReceipt({ journal: writeJournal, receipt, decisionAttestation,
    publicKey: created.signingPublicKeyPem });
  assert.equal(persisted.ok, !partial, persisted.code);
  db.close();
  const live = { ...service, show(id) {
    const result = service.show(id);
    if (outcomeStatus !== 'executed') result.body.approval.outcome.status = outcomeStatus;
    if (shownPatch) shownPatch(result.body.approval);
    return result;
  }, getDecision(id) {
    const result = service.getDecision(id);
    if (decisionPatch) decisionPatch(result.body);
    return result;
  } };
  const server = createAuthorityServer({ service: live, signingKey: state.signingKey });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const pin = { port: server.address().port, signingKey: created.signingPublicKeyPem };
  return { options: { journalPath, approvalId: 'approval', workspaceId: 'ws', capabilityId: 'replace' },
    deps: { resolveMode: () => ({ mode: 'service', pin }) }, pin, server, receipt,
    binding: { workspaceId: 'ws', capabilityId: 'replace', procedureHash: nextProcedure.hash },
    laterOutcome(capabilityId = 'replace', status = 'executed') {
      const laterArgs = { argv: ['--capability', capabilityId] };
      const laterHash = canonicalActionHash({ tool: 'terfi', workspaceId: 'ws', approvalId: 'later', arguments: laterArgs });
      assert.equal(service.register({ approvalId: 'later', workspaceId: 'ws', tool: 'terfi', arguments: laterArgs,
        actionHash: laterHash, consumeProofHash: crypto.createHash('sha256').update(consumeProof).digest('hex'),
        summary: 'later promotion', expiresAt: '2026-10-12T13:00:00Z' }).status, 201);
      const laterSealed = sealDecisionRequest({ approvalId: 'later', actionHash: laterHash, decision: 'approved',
        reason: 'later', totp: totpAt(created.totpSecret, Math.floor(now / 1000 / TOTP_STEP_SECONDS) + 1) }, created.sealingPublicKeyPem);
      assert.equal(service.decide('later', laterSealed).status, 200);
      assert.equal(service.consume('later', { actionHash: laterHash, consumeProof }).status, 200);
      if (status !== null) assert.equal(service.recordOutcome('later', { status, receiptId: 'later-receipt',
        receiptHash: 'd'.repeat(64), consumeProof }).status, 200);
    } };
}

for (const status of ['executed', 'failed', null]) test(`later ${status || 'unfinished'} promotion blocks an old receipt without a new journal record`, async t => {
  const f = await fixture(t);
  f.laterOutcome('replace', status);
  await assert.rejects(withCoderPromotionAcceptance(f.options, () => assert.fail('stale acceptance executed'), f.deps),
    /PROMOTION_ACCEPTANCE_SUPERSEDED/);
});

test('a later promotion of a different capability does not supersede this acceptance', async t => {
  const f = await fixture(t);
  f.laterOutcome('different');
  assert.equal(await withCoderPromotionAcceptance(f.options, () => 'accepted', f.deps), 'accepted');
});

test('history verification follows more than one signed ledger page', async t => {
  const f = await fixture(t, { padding: 501 });
  assert.equal(await withCoderPromotionAcceptance(f.options, () => 'accepted', f.deps), 'accepted');
});

test('a corrupt ledger is rejected even when no event follows the accepted outcome', async t => {
  const f = await fixture(t);
  const client = createAuthorityClient({ pin: f.pin });
  await assert.rejects(withCoderPromotionAcceptance(f.options, () => assert.fail('corrupt history executed'),
    { ...f.deps, createClient: () => ({ ...client, async ledgerEntries(options) {
      const result = await client.ledgerEntries(options);
      result.body.corrupt = { reason: 'broken' };
      return result;
    } }) }), /PROMOTION_HISTORY_UNAVAILABLE/);
});

for (const scenario of ['empty page', 'sequence gap', 'corrupt ledger', 'changed head', 'wrong anchor', 'excessive history'])
  test(`${scenario} cannot authorize execution from an incomplete history`, async t => {
    const f = await fixture(t);
    f.laterOutcome('different');
    const client = createAuthorityClient({ pin: f.pin });
    let heads = 0;
    const guarded = { ...client, async ledgerHead() {
      const result = await client.ledgerHead();
      if (++heads > 1 && scenario === 'changed head') result.body.hash = '0'.repeat(64);
      if (scenario === 'excessive history') result.body.seq += 10000;
      return result;
    }, async ledgerEntries(options) {
      const result = await client.ledgerEntries(options);
      if (scenario === 'empty page') result.body.entries = [];
      if (scenario === 'sequence gap') result.body.entries[0].seq++;
      if (scenario === 'wrong anchor') result.body.entries[0].receiptHash = '0'.repeat(64);
      if (scenario === 'corrupt ledger') result.body.corrupt = { reason: 'broken' };
      return result;
    } };
    await assert.rejects(withCoderPromotionAcceptance(f.options, () => assert.fail('incomplete history executed'),
      { ...f.deps, createClient: () => guarded }), /PROMOTION_HISTORY_(UNAVAILABLE|CHANGED)/);
  });

test('live signed authority permits one synchronous exact-bound consumption and revokes escaped tokens', async t => {
  const f = await fixture(t);
  let escaped;
  const result = await withCoderPromotionAcceptance(f.options, (token, receipt) => {
    escaped = token;
    assert.equal(Object.isFrozen(token), true);
    assert.equal(Object.isFrozen(receipt.nextProcedure.params), true);
    assert.deepEqual(consumeCoderPromotionAcceptance({ ...token }, f.binding), { ok: false, code: 'PROMOTION_ACCEPTANCE_REQUIRED' });
    assert.deepEqual(consumeCoderPromotionAcceptance(token, f.binding), { ok: true });
    assert.equal(consumeCoderPromotionAcceptance(token, f.binding).ok, false);
    return 'executed';
  }, f.deps);
  assert.equal(result, 'executed');
  assert.equal(consumeCoderPromotionAcceptance(escaped, f.binding).ok, false);
  await withCoderPromotionAcceptance(f.options, token => { escaped = token; }, f.deps);
  assert.equal(consumeCoderPromotionAcceptance(escaped, f.binding).ok, false);
  await assert.rejects(withCoderPromotionAcceptance(f.options, token => { escaped = token; throw new Error('callback failed'); }, f.deps), /callback failed/);
  assert.equal(consumeCoderPromotionAcceptance(escaped, f.binding).ok, false);
});

test('wrong workspace, capability and procedure hash consume no authority and burn the token', async t => {
  const f = await fixture(t);
  for (const patch of [{ workspaceId: 'other' }, { capabilityId: 'other' }, { procedureHash: 'x' }, { procedureHash: '0'.repeat(64) }])
    await withCoderPromotionAcceptance(f.options, token => {
      assert.equal(consumeCoderPromotionAcceptance(token, { ...f.binding, ...patch }).code, 'PROMOTION_ACCEPTANCE_BINDING_MISMATCH');
      assert.equal(consumeCoderPromotionAcceptance(token, f.binding).ok, false);
    }, f.deps);
});

test('legacy, unavailable authority, closed server and wrong pinned key never invoke callback', async t => {
  const f = await fixture(t);
  const execute = () => assert.fail('callback must not run');
  for (const mode of ['legacy', 'required_unavailable'])
    await assert.rejects(withCoderPromotionAcceptance(f.options, execute, { resolveMode: () => ({ mode }) }), /PROMOTION_AUTHORITY_REQUIRED/);
  const wrongKey = crypto.generateKeyPairSync('ed25519').publicKey;
  await assert.rejects(withCoderPromotionAcceptance(f.options, execute, { resolveMode: () => ({ mode: 'service',
    pin: { ...f.pin, signingKey: wrongKey } }) }));
  await assert.rejects(withCoderPromotionAcceptance(f.options, execute, { ...f.deps,
    createClient: () => createAuthorityClient({ pin: { ...f.pin, signingKey: wrongKey } }) }), /AUTHORITY_IMPERSONATION/);
  await new Promise(resolve => f.server.close(resolve));
  await assert.rejects(withCoderPromotionAcceptance(f.options, execute, f.deps), /AUTHORITY_UNAVAILABLE/);
});

for (const [name, scenario] of [
  ['failed outcome', { outcomeStatus: 'failed' }],
  ['missing outcome', { shownPatch: a => { a.outcome = null; } }],
  ['mismatched receipt', { shownPatch: a => { a.outcome.receiptHash = '0'.repeat(64); } }],
  ['unapproved status', { shownPatch: a => { a.status = 'withdrawn'; } }],
  ['missing consumption', { decisionPatch: a => { delete a.consumption; } }],
  ['tampered consumption', { decisionPatch: a => { a.consumption.payload.actionHash = '0'.repeat(64); } }],
  ['foreign action arguments', { shownPatch: a => { a.arguments = { argv: ['different'] }; } }],
  ['foreign workspace', { shownPatch: a => { a.workspaceId = 'other'; } }],
  ['foreign tool', { shownPatch: a => { a.tool = 'huqan.learn'; } }],
  ['withdrawal', { decisionPatch: a => { a.withdrawal = { at: 'now' }; } }],
  ['partial journal', { partial: true }],
]) test(`${name} refuses before callback`, async t => {
  const f = await fixture(t, scenario);
  await assert.rejects(withCoderPromotionAcceptance(f.options, () => assert.fail('callback must not run'), f.deps));
});

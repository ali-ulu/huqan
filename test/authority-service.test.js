'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { canonicalActionHash } = require('../lib/mcp-operator-capability');
const { createAuthorityState, openAuthorityState } = require('../lib/authority/state-store');
const { openLedgerStore } = require('../lib/authority/ledger-store');
const { createAuthorityService } = require('../lib/authority/authority-service');
const { sealDecisionRequest } = require('../lib/authority/sealed-request');
const { verifyDecision } = require('../lib/authority/decision-envelope');
const { totpAt, TOTP_STEP_SECONDS } = require('../lib/authority/totp');
const { MAX_FAILURES } = require('../lib/authority/operator-check');

const START = Date.parse('2026-10-12T12:00:00.000Z');

function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-authsvc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const created = createAuthorityState({ dir: path.join(dir, 'state') });
  const clock = { now: START };
  const open = () => createAuthorityService({ ledger: openLedgerStore({ file: path.join(dir, 'ledger.jsonl') }),
    state: openAuthorityState({ dir: path.join(dir, 'state') }), now: () => clock.now });
  const code = (offset = 0) => totpAt(created.totpSecret, Math.floor(clock.now / 1000 / TOTP_STEP_SECONDS) + offset);
  const seal = (fields) => sealDecisionRequest({ approvalId: 'apr_1', actionHash: ACTION.actionHash, decision: 'approved',
    reason: 'ok', totp: code(), ...fields }, created.sealingPublicKeyPem);
  return { dir, created, clock, open, code, seal, service: open() };
}

const ARGS = Object.freeze({ content: 'remember this' });
const PROOF = 'runtime-held-consume-proof-0123456789abcdef';
const PROOF_HASH = crypto.createHash('sha256').update(PROOF).digest('hex');
const ACTION = Object.freeze({
  approvalId: 'apr_1', workspaceId: 'default', tool: 'huqan.learn', arguments: ARGS,
  actionHash: canonicalActionHash({ tool: 'huqan.learn', workspaceId: 'default', approvalId: 'apr_1', arguments: ARGS }),
  consumeProofHash: PROOF_HASH, summary: 'learn one fact', expiresAt: '2026-10-12T13:00:00.000Z',
});

test('register, decide with a sealed code, and the signed decision verifies for that action', (t) => {
  const h = harness(t);
  assert.equal(h.service.register(ACTION).status, 201);
  assert.deepEqual(h.service.getDecision('apr_1'), { status: 200, body: { status: 'pending' } });
  const decided = h.service.decide('apr_1', h.seal());
  assert.equal(decided.status, 200);
  const expected = { approvalId: 'apr_1', workspaceId: 'default', tool: 'huqan.learn', actionHash: ACTION.actionHash,
    decision: 'approved' };
  const signing = crypto.createPublicKey(h.created.signingPublicKeyPem);
  assert.equal(verifyDecision(decided.body.envelope, { publicKey: signing, expected, now: h.clock.now }).ok, true);
  assert.deepEqual(h.service.getDecision('apr_1').body.envelope, decided.body.envelope);
});

test('the authority recomputes the action hash and refuses a registration whose hash lies', (t) => {
  const h = harness(t);
  const lie = h.service.register({ ...ACTION, actionHash: 'f'.repeat(64) });
  assert.deepEqual([lie.status, lie.body.code], [409, 'HASH_MISMATCH']);
  assert.equal(h.service.ledgerHead().body.seq, -1, 'nothing was recorded');
});

test('a sealed request for other arguments is refused before the code is checked or anything is written', (t) => {
  const h = harness(t);
  h.service.register(ACTION);
  const before = h.service.ledgerHead().body.seq;
  const result = h.service.decide('apr_1', h.seal({ actionHash: 'e'.repeat(64), consumeProof: PROOF }));
  assert.deepEqual([result.status, result.body.code], [409, 'HASH_MISMATCH']);
  assert.equal(h.service.ledgerHead().body.seq, before);
  assert.equal(h.service.decide('apr_1', h.seal()).status, 200, 'the operator code was not spent');
});

test('the same code cannot decide twice, and a second decision on one approval is refused', (t) => {
  const h = harness(t);
  h.service.register(ACTION);
  h.service.register({ ...ACTION, approvalId: 'apr_2', actionHash: canonicalActionHash({ ...ACTION, approvalId: 'apr_2' }) });
  const sealedCode = h.code();
  assert.equal(h.service.decide('apr_1', h.seal({ totp: sealedCode })).status, 200);
  const replay = h.service.decide('apr_2', sealDecisionRequest({ approvalId: 'apr_2',
    actionHash: canonicalActionHash({ ...ACTION, approvalId: 'apr_2' }), decision: 'approved', reason: '', totp: sealedCode },
  h.created.sealingPublicKeyPem));
  assert.deepEqual([replay.status, replay.body.code], [401, 'TOTP_REPLAYED']);
  h.clock.now += TOTP_STEP_SECONDS * 1000;
  assert.deepEqual(h.service.decide('apr_1', h.seal()).body.code, 'ALREADY_DECIDED');
});

test('a lockout is recorded in the ledger and survives a restart', (t) => {
  const h = harness(t);
  h.service.register(ACTION);
  for (let i = 0; i < MAX_FAILURES; i += 1) h.service.decide('apr_1', h.seal({ totp: '000000' }));
  const restarted = h.open();
  const locked = restarted.decide('apr_1', h.seal());
  assert.deepEqual([locked.status, locked.body.code], [423, 'LOCKED']);
  const types = restarted.ledgerEntries({}).body.entries.map(entry => entry.type);
  assert.equal(types.filter(type => type === 'totp.failed').length, MAX_FAILURES);
  assert.ok(types.includes('totp.lockout'));
});

test('an edited ledger refuses decisions after a restart but still serves reads', (t) => {
  const h = harness(t);
  h.service.register(ACTION);
  const file = path.join(h.dir, 'ledger.jsonl');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('learn one fact', 'learn two facts'));
  const restarted = h.open();
  assert.deepEqual(restarted.decide('apr_1', h.seal()).body.code, 'LEDGER_CORRUPT');
  assert.equal(restarted.decide('apr_1', h.seal()).status, 503);
  assert.equal(restarted.ledgerEntries({}).status, 200);
});

test('an approval is consumed exactly once, only with its hash, and only while the decision is valid', (t) => {
  const h = harness(t);
  h.service.register(ACTION);
  h.service.register({ ...ACTION, approvalId: 'apr_2', actionHash: canonicalActionHash({ ...ACTION, approvalId: 'apr_2' }) });
  assert.equal(h.service.consume('apr_1', { actionHash: ACTION.actionHash, consumeProof: PROOF }).body.code, 'NOT_APPROVED');
  h.service.decide('apr_1', h.seal());
  assert.equal(h.service.consume('apr_1', { actionHash: 'e'.repeat(64), consumeProof: PROOF }).body.code, 'HASH_MISMATCH');
  assert.equal(h.service.consume('apr_1', { actionHash: ACTION.actionHash, consumeProof: PROOF }).status, 200);
  assert.equal(h.service.consume('apr_1', { actionHash: ACTION.actionHash, consumeProof: PROOF }).body.code, 'ALREADY_CONSUMED');
  h.clock.now += TOTP_STEP_SECONDS * 1000;
  h.service.decide('apr_2', sealDecisionRequest({ approvalId: 'apr_2', actionHash: canonicalActionHash({ ...ACTION, approvalId: 'apr_2' }),
    decision: 'approved', reason: '', totp: h.code() }, h.created.sealingPublicKeyPem));
  h.clock.now += 11 * 60 * 1000;
  assert.equal(h.service.consume('apr_2', { actionHash: canonicalActionHash({ ...ACTION, approvalId: 'apr_2' }), consumeProof: PROOF }).body.code,
    'DECISION_EXPIRED');
});

test('an outcome is recorded only after consumption', (t) => {
  const h = harness(t);
  h.service.register(ACTION);
  h.service.decide('apr_1', h.seal());
  const outcome = { status: 'executed', receiptId: 'rcpt_1', receiptHash: 'c'.repeat(64), consumeProof: PROOF };
  assert.equal(h.service.recordOutcome('apr_1', outcome).body.code, 'NOT_CONSUMED');
  h.service.consume('apr_1', { actionHash: ACTION.actionHash, consumeProof: PROOF });
  assert.equal(h.service.recordOutcome('apr_1', outcome).status, 200);
  assert.equal(h.service.recordOutcome('apr_1', outcome).body.code, 'OUTCOME_RECORDED');
});

test('registration is bounded: expired, oversized, malformed, or past the rate limit', (t) => {
  const h = harness(t);
  for (const [fields, code] of [[{ expiresAt: '2026-10-12T11:00:00.000Z' }, 'EXPIRED'], [{ approvalId: 'bad id!' }, 'INVALID'],
    [{ summary: 's'.repeat(513) }, 'INVALID'], [{ expiresAt: '2026-10-12T12:04:00.000Z' }, 'INVALID'],
    [{ consumeProofHash: 'x' }, 'INVALID'], [{ arguments: { blob: 'x'.repeat(17 * 1024) } }, 'INVALID']]) {
    assert.equal(h.service.register({ ...ACTION, ...fields }).body.code, code, JSON.stringify(Object.keys(fields)));
  }
  let last;
  for (let i = 0; i < 61; i += 1) {
    const approvalId = `apr_r${i}`;
    last = h.service.register({ ...ACTION, approvalId, actionHash: canonicalActionHash({ ...ACTION, approvalId }) });
  }
  assert.deepEqual([last.status, last.body.code], [429, 'RATE_LIMITED']);
});

test('re-registering the same action is idempotent; a different action under the same id conflicts', (t) => {
  const h = harness(t);
  assert.equal(h.service.register(ACTION).status, 201);
  assert.equal(h.service.register(ACTION).status, 200);
  const other = { ...ACTION, arguments: { content: 'other' } };
  const conflict = h.service.register({ ...other, actionHash: canonicalActionHash(other) });
  assert.deepEqual([conflict.status, conflict.body.code], [409, 'CONFLICT']);
});

test('consume and outcome need the proof only the registering runtime holds', (t) => {
  const h = harness(t);
  h.service.register(ACTION);
  h.service.decide('apr_1', h.seal());
  for (const consumeProof of [undefined, 'guess', `${PROOF}x`]) {
    assert.deepEqual(h.service.consume('apr_1', { actionHash: ACTION.actionHash, consumeProof }).body.code, 'PROOF_REQUIRED');
  }
  assert.equal(h.service.recordOutcome('apr_1', { status: 'failed', receiptId: 'x', receiptHash: null }).body.code, 'PROOF_REQUIRED');
  assert.equal(h.service.consume('apr_1', { actionHash: ACTION.actionHash, consumeProof: PROOF }).status, 200);
});

test('a restart past one ledger page still knows what was consumed', (t) => {
  const h = harness(t);
  const filler = openLedgerStore({ file: path.join(h.dir, 'ledger.jsonl') });
  for (let i = 0; i < 600; i += 1) filler.append('totp.failed', { approvalId: `noise_${i}`, code: 'TOTP_INVALID' }, ACTION.expiresAt);
  const service = h.open();
  service.register(ACTION);
  service.decide('apr_1', h.seal());
  assert.equal(service.consume('apr_1', { actionHash: ACTION.actionHash, consumeProof: PROOF }).status, 200);
  assert.ok(service.ledgerHead().body.seq > 600, 'the consumption sits past the first page');
  const restarted = h.open();
  assert.equal(restarted.consume('apr_1', { actionHash: ACTION.actionHash, consumeProof: PROOF }).body.code, 'ALREADY_CONSUMED');
});

test('a code is spent even when the ledger write after it fails', (t) => {
  const h = harness(t);
  h.service.register(ACTION);
  const ledger = openLedgerStore({ file: path.join(h.dir, 'ledger.jsonl') });
  const failing = { ...ledger, get corrupt() { return ledger.corrupt; }, all: ledger.all, head: ledger.head, entries: ledger.entries,
    append: (type, ...rest) => { if (type === 'approval.decided') throw new Error('disk gone'); return ledger.append(type, ...rest); } };
  const service = createAuthorityService({ ledger: failing, state: openAuthorityState({ dir: path.join(h.dir, 'state') }),
    now: () => h.clock.now });
  const code = h.code();
  assert.throws(() => service.decide('apr_1', h.seal({ totp: code })), /disk gone/);
  const again = h.open().decide('apr_1', h.seal({ totp: code }));
  assert.deepEqual([again.status, again.body.code], [401, 'TOTP_REPLAYED']);
});

test('re-registering after expiry returns the existing record, and invalid attempts count toward the rate limit', (t) => {
  const h = harness(t);
  h.service.register(ACTION);
  h.clock.now = Date.parse(ACTION.expiresAt) + 1000;
  assert.equal(h.service.register(ACTION).status, 200);
  let last;
  for (let i = 0; i < 61; i += 1) last = h.service.register({ approvalId: 'bad id!' });
  assert.deepEqual([last.status, last.body.code], [429, 'RATE_LIMITED']);
});

test('an approved but unconsumed decision can be withdrawn, and consumption is then refused', (t) => {
  const h = harness(t);
  h.service.register(ACTION);
  assert.equal(h.service.decide('apr_1', h.seal()).status, 200);
  h.clock.now += TOTP_STEP_SECONDS * 1000;
  const withdrawn = h.service.withdraw('apr_1', h.seal({ decision: 'withdrawn', reason: 'agent compromised' }));
  assert.equal(withdrawn.status, 200);
  assert.equal(h.service.show('apr_1').body.approval.status, 'withdrawn');
  const refused = h.service.consume('apr_1', { actionHash: ACTION.actionHash, consumeProof: PROOF });
  assert.deepEqual([refused.status, refused.body.code], [409, 'WITHDRAWN']);
  const types = h.service.ledgerEntries().body.entries.map(entry => entry.type);
  assert.ok(types.includes('approval.withdrawn'));
  assert.ok(!types.includes('approval.consumed'), 'nothing was consumed');
  assert.equal(h.service.getDecision('apr_1').body.withdrawal.reason, 'agent compromised');
  h.clock.now += TOTP_STEP_SECONDS * 1000;
  assert.equal(h.service.withdraw('apr_1', h.seal({ decision: 'withdrawn' })).body.code, 'ALREADY_WITHDRAWN');
  assert.equal(h.open().consume('apr_1', { actionHash: ACTION.actionHash, consumeProof: PROOF }).body.code, 'WITHDRAWN',
    'the withdrawal survives a restart');
});

test('a consumed approval cannot be withdrawn', (t) => {
  const h = harness(t);
  h.service.register(ACTION);
  h.service.decide('apr_1', h.seal());
  assert.equal(h.service.consume('apr_1', { actionHash: ACTION.actionHash, consumeProof: PROOF }).status, 200);
  h.clock.now += TOTP_STEP_SECONDS * 1000;
  assert.equal(h.service.withdraw('apr_1', h.seal({ decision: 'withdrawn' })).body.code, 'ALREADY_CONSUMED');
});

test('withdrawal needs the operator code, a pending approval is not withdrawable, and the two requests do not cross over', (t) => {
  const h = harness(t);
  h.service.register(ACTION);
  assert.equal(h.service.withdraw('apr_1', h.seal({ decision: 'withdrawn' })).body.code, 'NOT_APPROVED');
  assert.equal(h.service.decide('apr_1', h.seal({ decision: 'withdrawn' })).body.code, 'SEALED_REQUEST_INVALID',
    'a withdrawal request is not a decision');
  h.service.decide('apr_1', h.seal());
  h.clock.now += TOTP_STEP_SECONDS * 1000;
  assert.equal(h.service.withdraw('apr_1', h.seal()).body.code, 'SEALED_REQUEST_INVALID', 'a decision request is not a withdrawal');
  assert.equal(h.service.withdraw('apr_1', h.seal({ decision: 'withdrawn', totp: '000000' })).body.code, 'TOTP_INVALID');
  assert.equal(h.service.show('apr_1').body.approval.status, 'approved');
});

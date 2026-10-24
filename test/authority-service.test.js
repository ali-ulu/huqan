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
const { createAuthorityService, MAX_ATTEMPTS_PER_MINUTE } = require('../lib/authority/authority-service');
const { validatePolicy, createOperatorApiKeySalt, createOperatorApiKeyVerifier } = require('../lib/approval-rbac');
const { sealDecisionRequest } = require('../lib/authority/sealed-request');
const { verifyDecision, verifyOutcomeAttestation, OUTCOME_ATTESTATION_VERSION } = require('../lib/authority/decision-envelope');
const { stableStringify } = require('../lib/hash-chain');
const { totpAt, TOTP_STEP_SECONDS } = require('../lib/authority/totp');
const { MAX_FAILURES } = require('../lib/authority/operator-check');

const START = Date.parse('2026-10-12T12:00:00.000Z');

function harness(t, rbacPolicy) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-authsvc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const created = createAuthorityState({ dir: path.join(dir, 'state') });
  const clock = { now: START };
  const open = () => createAuthorityService({ ledger: openLedgerStore({ file: path.join(dir, 'ledger.jsonl') }),
    state: openAuthorityState({ dir: path.join(dir, 'state') }), now: () => clock.now,
    ...(rbacPolicy ? { rbacPolicy } : {}) });
  const code = (offset = 0) => totpAt(created.totpSecret, Math.floor(clock.now / 1000 / TOTP_STEP_SECONDS) + offset);
  const seal = (fields = {}) => {
    const request = { approvalId: 'apr_1', actionHash: ACTION.actionHash, decision: 'approved',
      reason: 'ok', totp: code(), ...fields };
    return sealDecisionRequest(request, created.sealingPublicKeyPem, { requireTotp: request.totp !== null });
  };
  return { dir, created, clock, open, code, seal, service: open() };
}

const ARGS = Object.freeze({ content: 'remember this' });
const PROOF = 'runtime-held-consume-proof-0123456789abcdef';
const PROOF_HASH = crypto.createHash('sha256').update(PROOF).digest('hex');
const readLedger = dir => fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(line => JSON.parse(line));

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

test('N-of-M quorum counts authenticated distinct operators and survives restart', (t) => {
  const aliceKey = `alice-${'a'.repeat(48)}`;
  const bobKey = `bob-${'b'.repeat(48)}`;
  const operatorApiKeySalt = createOperatorApiKeySalt();
  const rbacPolicy = validatePolicy({
    version: 1,
    roles: { approver: ['approvals.view', 'approvals.decide'] },
    operators: { alice: 'approver', bob: 'approver' },
    operatorApiKeySalt,
    operatorApiKeyVerifiers: {
      alice: createOperatorApiKeyVerifier(aliceKey, operatorApiKeySalt),
      bob: createOperatorApiKeyVerifier(bobKey, operatorApiKeySalt),
    },
    quorum: { default: 1, byTool: { 'huqan.learn': 2 } },
  });
  assert.equal(rbacPolicy.ok, true, rbacPolicy.reason);
  const h = harness(t, rbacPolicy);
  assert.equal(h.service.register(ACTION).status, 201);

  const first = h.service.decide('apr_1', h.seal({ totp: null }), { apiKey: aliceKey, operatorIdHint: 'alice' });
  assert.equal(first.status, 202);
  assert.deepEqual(first.body.quorum, { required: 2, received: 1, approverIds: ['alice'] });
  assert.deepEqual(h.service.getDecision('apr_1').body.quorum, first.body.quorum);

  const restarted = h.open();
  const aliceVote = restarted.show('apr_1').body.approval.votes[0];
  assert.deepEqual({
    workspaceId: aliceVote.workspaceId, tool: aliceVote.tool, actionHash: aliceVote.actionHash,
    operatorId: aliceVote.operatorId, decision: aliceVote.decision, authMethod: aliceVote.authMethod,
    policyVersion: aliceVote.policyVersion, policyHash: aliceVote.policyHash,
  }, {
    workspaceId: 'default', tool: 'huqan.learn', actionHash: ACTION.actionHash,
    operatorId: 'alice', decision: 'approved', authMethod: 'api_key',
    policyVersion: rbacPolicy.policy.version, policyHash: rbacPolicy.policy.hash,
  }, 'the durable vote names the workspace, tool, credential method and policy');

  const replay = restarted.decide('apr_1', h.seal({ totp: null }), { apiKey: aliceKey, operatorIdHint: 'alice' });
  assert.deepEqual([replay.status, replay.body.idempotent, replay.body.quorum], [202, true, first.body.quorum],
    'repeating the same vote is idempotent and reports the same quorum');
  assert.equal(restarted.show('apr_1').body.approval.votes.length, 1, 'repeat vote adds no ledger vote');

  const conflicting = restarted.decide('apr_1', h.seal({ totp: null, decision: 'rejected' }), { apiKey: aliceKey, operatorIdHint: 'alice' });
  assert.deepEqual([conflicting.status, conflicting.body.code], [409, 'DUPLICATE_APPROVER']);
  assert.equal(restarted.show('apr_1').body.approval.votes.length, 1, 'the opposite vote is not recorded as a vote');
  const denial = readLedger(h.dir).filter(entry => entry.type === 'approval.vote_denied').at(-1);
  assert.deepEqual([denial.body.code, denial.body.operatorId, denial.body.priorDecision, denial.body.attemptedDecision],
    ['DUPLICATE_APPROVER', 'alice', 'approved', 'rejected'], 'a conflicting replay is refused and audited');

  const second = restarted.decide('apr_1', h.seal({ totp: null }), { apiKey: bobKey, operatorIdHint: 'bob' });
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.envelope.payload.approverIds, ['alice', 'bob']);
  assert.equal(second.body.envelope.payload.quorumRequired, 2);
  assert.equal(second.body.envelope.payload.operatorId, 'bob');
  assert.equal(second.body.envelope.payload.policyVersion, rbacPolicy.policy.version);
  assert.equal(second.body.envelope.payload.policyHash, rbacPolicy.policy.hash);
  assert.equal(verifyDecision(second.body.envelope, {
    publicKey: crypto.createPublicKey(h.created.signingPublicKeyPem),
    expected: { approvalId: 'apr_1', workspaceId: 'default', tool: 'huqan.learn', actionHash: ACTION.actionHash,
      decision: 'approved', operatorId: 'bob', approverIds: ['alice', 'bob'], quorumRequired: 2 },
    now: h.clock.now,
  }).ok, true);
  assert.equal(restarted.show('apr_1').body.approval.votes.length, 2);
  const bobVote = restarted.show('apr_1').body.approval.votes[1];
  assert.deepEqual([bobVote.workspaceId, bobVote.tool, bobVote.operatorId, bobVote.authMethod,
    bobVote.policyVersion, bobVote.policyHash],
  ['default', 'huqan.learn', 'bob', 'api_key', rbacPolicy.policy.version, rbacPolicy.policy.hash]);

  const consumed = restarted.consume('apr_1', { actionHash: ACTION.actionHash, consumeProof: PROOF });
  assert.equal(consumed.status, 200);
  const receiptHash = 'c'.repeat(64);
  const outcome = restarted.recordOutcome('apr_1', {
    status: 'executed', receiptId: 'execution-receipt-1', receiptHash, consumeProof: PROOF,
  });
  assert.equal(outcome.status, 200);
  const storedEnvelope = restarted.getDecision('apr_1').body.envelope;
  assert.deepEqual(storedEnvelope, second.body.envelope, 'stored decision is the quorum envelope returned to the approver');
  const expectedEnvelopeHash = crypto.createHash('sha256')
    .update(stableStringify(storedEnvelope), 'utf8').digest('hex');
  assert.equal(outcome.body.attestation.payload.operatorId, 'bob');
  assert.equal(outcome.body.attestation.payload.decisionEnvelopeHash, expectedEnvelopeHash,
    'signed execution evidence binds the exact quorum decision envelope');
  assert.equal(outcome.body.attestation.payload.receiptHash, receiptHash,
    'receipt hash remains unchanged and is covered by the authority signature');
  assert.equal(verifyOutcomeAttestation(outcome.body.attestation, {
    publicKey: crypto.createPublicKey(h.created.signingPublicKeyPem),
    expected: {
      approvalId: 'apr_1', workspaceId: 'default', tool: 'huqan.learn', actionHash: ACTION.actionHash,
      decision: 'approved', operatorId: 'bob', decisionEnvelopeHash: expectedEnvelopeHash,
      status: 'executed', receiptId: 'execution-receipt-1', receiptHash,
      recordedAt: outcome.body.attestation.payload.recordedAt,
      ledgerSeq: outcome.body.outcome.ledgerSeq, ledgerHash: outcome.body.outcome.ledgerHash,
    },
  }).ok, true);
  assert.equal(verifyOutcomeAttestation({
    ...outcome.body.attestation,
    payload: { ...outcome.body.attestation.payload, operatorId: 'mallory' },
  }, { publicKey: crypto.createPublicKey(h.created.signingPublicKeyPem) }).code, 'signature_invalid');
});

test('a quorum that reached its threshold before a crash is finalized from the durable vote ledger', (t) => {
  const aliceKey = `alice-${'a'.repeat(48)}`;
  const bobKey = `bob-${'b'.repeat(48)}`;
  const operatorApiKeySalt = createOperatorApiKeySalt();
  const rbacPolicy = validatePolicy({
    version: 1,
    roles: { approver: ['approvals.view', 'approvals.decide'] },
    operators: { alice: 'approver', bob: 'approver' },
    operatorApiKeySalt,
    operatorApiKeyVerifiers: {
      alice: createOperatorApiKeyVerifier(aliceKey, operatorApiKeySalt),
      bob: createOperatorApiKeyVerifier(bobKey, operatorApiKeySalt),
    },
    quorum: { default: 2 },
  });
  const h = harness(t, rbacPolicy);
  assert.equal(h.service.register(ACTION).status, 201);
  assert.equal(h.service.decide('apr_1', h.seal({ totp: null }), { apiKey: aliceKey, operatorIdHint: 'alice' }).status, 202);

  // Simulate a process crash after the second vote was durably appended but
  // before approval.decided was appended.
  openLedgerStore({ file: path.join(h.dir, 'ledger.jsonl') }).append('approval.vote', {
    approvalId: 'apr_1', actionHash: ACTION.actionHash, operatorId: 'bob', decision: 'approved',
    reason: 'independent review', votedAt: new Date(h.clock.now).toISOString(), quorumRequired: 2,
  }, new Date(h.clock.now).toISOString());

  const restarted = h.open();
  const recovered = restarted.decide('apr_1', 'not-used-during-recovery', { apiKey: 'invalid'.padEnd(48, 'x') });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.recovered, true);
  assert.deepEqual(recovered.body.envelope.payload.approverIds, ['alice', 'bob']);
  assert.equal(recovered.body.envelope.payload.operatorId, 'bob');
  assert.deepEqual([recovered.body.envelope.payload.policyVersion, recovered.body.envelope.payload.policyHash],
    [rbacPolicy.policy.version, rbacPolicy.policy.hash],
    'a vote that predates #4215 recovers under the policy that applied the threshold');
  assert.equal(restarted.show('apr_1').body.approval.status, 'approved');
  assert.equal(restarted.ledgerEntries().body.entries.filter(entry => entry.type === 'approval.decided').length, 1);
});

test('an invalid operator API key cannot vote or consume a TOTP code', (t) => {
  const key = `alice-${'a'.repeat(48)}`;
  const operatorApiKeySalt = createOperatorApiKeySalt();
  const rbacPolicy = validatePolicy({
    version: 1,
    roles: { approver: ['approvals.view', 'approvals.decide'] },
    operators: { alice: 'approver' },
    operatorApiKeySalt,
    operatorApiKeyVerifiers: { alice: createOperatorApiKeyVerifier(key, operatorApiKeySalt) },
    quorum: { default: 1 },
  });
  const h = harness(t, rbacPolicy);
  assert.equal(h.service.register(ACTION).status, 201);
  const before = h.service.show('apr_1').body.approval.votes.length;
  const totpBefore = openAuthorityState({ dir: path.join(h.dir, 'state') }).readTotp();
  const refused = h.service.decide('apr_1', h.seal({ totp: null }), { apiKey: 'wrong-key'.padEnd(48, 'x'), operatorIdHint: 'alice' });
  assert.deepEqual([refused.status, refused.body.code], [401, 'APPROVAL_RBAC_API_KEY_INVALID']);
  assert.equal(h.service.show('apr_1').body.approval.votes.length, before, 'invalid credentials add no vote');
  assert.deepEqual(openAuthorityState({ dir: path.join(h.dir, 'state') }).readTotp(), totpBefore,
    'invalid credentials do not consume or advance the shared TOTP state');
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

test('an outcome is recorded only after consumption and returns a signed receipt binding', (t) => {
  const h = harness(t);
  h.service.register(ACTION);
  h.service.decide('apr_1', h.seal());
  const outcome = { status: 'executed', receiptId: 'rcpt_1', receiptHash: 'c'.repeat(64), consumeProof: PROOF };
  assert.equal(h.service.recordOutcome('apr_1', outcome).body.code, 'NOT_CONSUMED');
  h.service.consume('apr_1', { actionHash: ACTION.actionHash, consumeProof: PROOF });

  const recorded = h.service.recordOutcome('apr_1', outcome);
  assert.equal(recorded.status, 200);
  assert.equal(recorded.body.attestation.payload.receiptId, 'rcpt_1');
  const decisionEnvelope = h.service.getDecision('apr_1').body.envelope;
  const decisionEnvelopeHash = crypto.createHash('sha256').update(stableStringify(decisionEnvelope), 'utf8').digest('hex');
  const verified = verifyOutcomeAttestation(recorded.body.attestation, {
    publicKey: crypto.createPublicKey(h.created.signingPublicKeyPem),
    expected: {
      v: OUTCOME_ATTESTATION_VERSION,
      approvalId: 'apr_1',
      workspaceId: 'default',
      tool: 'huqan.learn',
      actionHash: ACTION.actionHash,
      decision: 'approved',
      operatorId: null,
      decisionEnvelopeHash,
      status: 'executed',
      receiptId: 'rcpt_1',
      receiptHash: 'c'.repeat(64),
      recordedAt: recorded.body.attestation.payload.recordedAt,
      ledgerSeq: recorded.body.outcome.ledgerSeq,
      ledgerHash: recorded.body.outcome.ledgerHash,
    },
  });
  assert.equal(verified.ok, true, verified.code);
  const duplicate = h.service.recordOutcome('apr_1', outcome);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.deepEqual(duplicate.body.attestation, recorded.body.attestation, 'a retry gets the same durable signed outcome');
  assert.equal(h.service.recordOutcome('apr_1', { ...outcome, receiptId: 'different-receipt' }).body.code, 'OUTCOME_RECORDED');
  assert.equal(h.service.ledgerEntries().body.entries.filter(entry => entry.type === 'approval.outcome').length, 1,
    'idempotent recovery does not append twice');
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

function apiKeyPolicy(extra = {}) {
  const keys = { alice: `alice-${'a'.repeat(48)}`, bob: `bob-${'b'.repeat(48)}` };
  const operatorApiKeySalt = createOperatorApiKeySalt();
  const rbacPolicy = validatePolicy({
    version: 1,
    roles: { approver: ['approvals.view', 'approvals.decide'] },
    operators: { alice: 'approver', bob: 'approver' },
    operatorApiKeySalt,
    operatorApiKeyVerifiers: Object.fromEntries(Object.entries(keys)
      .map(([id, key]) => [id, createOperatorApiKeyVerifier(key, operatorApiKeySalt)])),
    quorum: { default: 1 },
    ...extra,
  });
  assert.equal(rbacPolicy.ok, true, rbacPolicy.reason);
  return { keys, rbacPolicy };
}

for (const operation of ['decide', 'withdraw']) {
  test(`a full operator attempt window refuses ${operation} before any scrypt verification`, (t) => {
    const { keys, rbacPolicy } = apiKeyPolicy();
    const h = harness(t, rbacPolicy);
    assert.equal(h.service.register(ACTION).status, 201);
    if (operation === 'withdraw') {
      assert.equal(h.service.decide('apr_1', h.seal({ totp: null }), { apiKey: keys.alice, operatorIdHint: 'alice' }).status, 200);
    }
    const call = (options, fields) => h.service[operation]('apr_1',
      h.seal({ totp: null, ...(operation === 'withdraw' ? { decision: 'withdrawn' } : {}), ...fields }), options);
    // A missing key is denied without scrypt, so the window fills cheaply.
    for (let i = 0; i < MAX_ATTEMPTS_PER_MINUTE; i += 1) {
      assert.equal(call({ operatorIdHint: 'alice' }).body.code, 'APPROVAL_RBAC_API_KEY_REQUIRED');
    }
    const scrypt = t.mock.method(crypto, 'scryptSync');
    const limited = call({ apiKey: `alice-${'z'.repeat(48)}`, operatorIdHint: 'alice' });
    assert.deepEqual([limited.status, limited.body.code], [429, 'RATE_LIMITED']);
    assert.equal(scrypt.mock.callCount(), 0, 'no scrypt work while the window is full');
    h.clock.now += 61 * 1000;
    assert.equal(call({ apiKey: `alice-${'z'.repeat(48)}`, operatorIdHint: 'alice' }).body.code, 'APPROVAL_RBAC_API_KEY_INVALID');
    assert.equal(scrypt.mock.callCount(), 1, 'verification resumes once the window clears');
  });
}

test('under separation of duties the requester cannot cast an early quorum vote', (t) => {
  const { keys, rbacPolicy } = apiKeyPolicy({ separationOfDuties: true, quorum: { default: 2 } });
  const h = harness(t, rbacPolicy);
  assert.equal(h.service.register({ ...ACTION, requesterId: 'alice' }).status, 201);
  const early = h.service.decide('apr_1', h.seal({ totp: null }), { apiKey: keys.alice, operatorIdHint: 'alice' });
  assert.deepEqual([early.status, early.body.code], [403, 'APPROVAL_RBAC_SEPARATION_OF_DUTIES']);
  assert.equal(h.service.show('apr_1').body.approval.votes.length, 0, 'the requester vote is not recorded');
  const other = h.service.decide('apr_1', h.seal({ totp: null }), { apiKey: keys.bob, operatorIdHint: 'bob' });
  assert.deepEqual([other.status, other.body.quorum.received], [202, 1], 'requester plus one other never reaches quorum');
  assert.equal(h.service.show('apr_1').body.approval.status, 'pending');
});

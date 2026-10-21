'use strict';

// #4104: the demo is the claim, so the claim is tested. Nothing here asserts on
// printed text: it asserts on what happened to the file, on what the gate
// allowed, and on whether the receipt that records it verifies.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { runDemo } = require('../scripts/agent-brake-demo');
const { createDemoAuthority, verifyDemoDecision } = require('../lib/demo-authority');
const { requireAuthorityDecision } = require('../lib/authority/decision-guard');
const { DECISION_VERSION, DEMO_DECISION_VERSION } = require('../lib/authority/decision-envelope');
const { canonicalActionHash } = require('../lib/mcp-operator-capability');

const quiet = () => {};

function demoDecision({ authority, decision = 'approved', at }) {
  const actionHash = canonicalActionHash({ tool: 'Bash', workspaceId: 'demo', approvalId: 'approval-1',
    arguments: { command: 'rm notes.txt' } });
  const decided = authority.decide({ approvalId: 'approval-1', workspaceId: 'demo', tool: 'Bash', actionHash,
    decision, code: authority.codeAt(at), at });
  assert.equal(decided.ok, true, `demo decision refused: ${decided.code}`);
  return { envelope: decided.envelope, actionHash };
}

test('a delete waits for an operator decision and then runs once', () => {
  const result = runDemo({ log: quiet });

  // The gate stopped it: a review is not an allow, so the host ran nothing.
  assert.equal(result.firstAttempt.decision, 'review');
  assert.equal(result.firstAttempt.canExecute, false);
  assert.equal(result.checks.blockedWithoutDecision, true);
  assert.equal(result.wrongCodeRefusal, 'TOTP_INVALID');

  // The authorized decision is what let it run, and the file is gone.
  assert.equal(result.authorization.ok, true);
  assert.equal(result.executed, true);
  assert.equal(fs.existsSync(result.notesPath), false);
  assert.equal(result.checks.executedOnlyWhenApproved, true);
});

test('a rejected decision leaves the file alone', () => {
  const result = runDemo({ operatorDecision: 'rejected', log: quiet });

  assert.equal(result.executed, false);
  assert.equal(fs.existsSync(result.notesPath), true);
  assert.equal(result.checks.executedOnlyWhenApproved, true);
  assert.equal(result.checks.blockedWithoutDecision, true);
});

test('the receipt the demo leaves behind verifies, chain and seal alike', () => {
  const result = runDemo({ log: quiet });

  assert.match(result.receipt.receiptId, /^trust-receipt:[0-9a-f]{64}$/);
  assert.equal(result.receipt.chainValid, true, `chain: ${result.receipt.chainStatus}`);
  assert.equal(result.receipt.sealValid, true, `seal: ${result.receipt.sealReason}`);
  assert.equal(result.checks.receiptVerified, true);
});

test('the runtime decision guard refuses a demo decision', () => {
  const now = Date.now();
  const authority = createDemoAuthority({ now: () => now });
  const { envelope, actionHash } = demoDecision({ authority, at: now });

  for (const mode of [{ mode: 'service', boundary: 'os-service', pin: { signingKey: authority.publicKey } },
    { mode: 'legacy', boundary: 'same-user' }]) {
    const refused = requireAuthorityDecision({
      mode,
      existing: { tool: 'Bash' },
      approvalId: 'approval-1',
      workspaceId: 'demo',
      decision: 'approved',
      storedArgs: { command: 'rm notes.txt' },
      envelope,
      now,
    });
    assert.equal(refused.ok, false, `${mode.mode} mode accepted a demo decision`);
    assert.equal(refused.code, 'DEMO_AUTHORITY_REFUSED');
    assert.equal(refused.ok === false && actionHash.length, 64);
  }
});

test('the two decision verifiers refuse each other', () => {
  const now = Date.now();
  const authority = createDemoAuthority({ now: () => now });
  const { envelope, actionHash } = demoDecision({ authority, at: now });
  const expected = { approvalId: 'approval-1', workspaceId: 'demo', tool: 'Bash', actionHash, decision: 'approved' };

  assert.equal(verifyDemoDecision(envelope, { publicKey: authority.publicKey, expected, now }).ok, true);

  // A demo verifier must not be able to claim a real authority's decision.
  const real = { ...envelope, payload: { ...envelope.payload, v: DECISION_VERSION } };
  assert.deepEqual(verifyDemoDecision(real, { publicKey: authority.publicKey, expected, now }),
    { ok: false, code: 'not_demo_decision' });
  assert.equal(envelope.payload.v, DEMO_DECISION_VERSION);
});

test('the demo authority refuses a replayed code and a code for another action', () => {
  const now = Date.now();
  const authority = createDemoAuthority({ now: () => now });
  const actionHash = canonicalActionHash({ tool: 'Bash', workspaceId: 'demo', approvalId: 'approval-1',
    arguments: { command: 'rm notes.txt' } });
  const code = authority.codeAt(now);

  const first = authority.decide({ approvalId: 'approval-1', workspaceId: 'demo', tool: 'Bash', actionHash,
    decision: 'approved', code, at: now });
  assert.equal(first.ok, true);

  const replay = authority.decide({ approvalId: 'approval-2', workspaceId: 'demo', tool: 'Bash', actionHash,
    decision: 'approved', code, at: now });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, 'TOTP_REPLAYED');

  const malformed = authority.decide({ approvalId: 'approval-3', workspaceId: 'demo', tool: 'Bash', actionHash,
    decision: 'approved', code: '12345', at: now });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, 'TOTP_INVALID');

  const bound = verifyDemoDecision(first.envelope, { publicKey: authority.publicKey, now,
    expected: { approvalId: 'approval-1', workspaceId: 'demo', tool: 'Bash', actionHash: 'f'.repeat(64),
      decision: 'approved' } });
  assert.deepEqual(bound, { ok: false, code: 'binding_mismatch' });
});

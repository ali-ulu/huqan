'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { canonicalActionHash } = require('../lib/mcp-operator-capability');
const { signDecision, DECISION_VERSION } = require('../lib/authority/decision-envelope');
const { requireAuthorityDecision } = require('../lib/authority/decision-guard');
const { signConsumption } = require('../lib/authority/consumption-envelope');

const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const signing = crypto.generateKeyPairSync('ed25519');
const SERVICE = Object.freeze({ mode: 'service', boundary: 'os-service', pin: { signingKey: signing.publicKey } });
const ARGS = Object.freeze({ content: 'remember this', workspaceId: 'default' });
const EXISTING = Object.freeze({ id: 'apr_1', tool: 'axiom.learn', workspaceId: 'default', context: { args: ARGS } });
const ACTION_HASH = canonicalActionHash({ tool: 'huqan.learn', workspaceId: 'default', approvalId: 'apr_1', arguments: ARGS });

function envelope(overrides = {}, key = signing.privateKey) {
  return signDecision({ v: DECISION_VERSION, approvalId: 'apr_1', workspaceId: 'default', tool: 'huqan.learn',
    actionHash: ACTION_HASH, decision: 'approved', reason: '', decidedAt: '2026-10-12T11:59:00.000Z',
    validUntil: '2026-10-12T12:09:00.000Z', ledgerSeq: 3, ledgerHash: 'b'.repeat(64), operator: 'totp:primary', ...overrides }, key);
}

function consumption(overrides = {}, key = signing.privateKey) {
  return signConsumption({ approvalId: 'apr_1', workspaceId: 'default', tool: 'huqan.learn', actionHash: ACTION_HASH,
    ledgerSeq: 4, ledgerHash: 'c'.repeat(64), consumedAt: '2026-10-12T11:59:30.000Z', ...overrides }, key);
}

const guard = (fields = {}) => requireAuthorityDecision({ mode: SERVICE, existing: EXISTING, approvalId: 'apr_1',
  workspaceId: 'default', decision: 'approved', storedArgs: ARGS, now: NOW, envelope: envelope(), consumption: consumption(),
  ...fields });

test('legacy mode changes nothing and says the boundary is the same user', () => {
  assert.deepEqual(guard({ mode: { mode: 'legacy', boundary: 'same-user' }, envelope: undefined }),
    { ok: true, boundary: 'same-user' });
});

test('service mode accepts the authority decision for exactly this action', () => {
  const result = guard();
  assert.equal(result.ok, true);
  assert.equal(result.boundary, 'os-service');
  assert.equal(result.decision.ledgerSeq, 3);
});

test('service mode without a signed decision refuses, whatever else the caller holds', () => {
  const result = guard({ envelope: undefined });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AUTHORITY_DECISION_REQUIRED');
  assert.match(result.message, /huqan-authority/);
});

test('a decision for other arguments, another approval, the other verdict, or from another key is refused', () => {
  const cases = [
    { storedArgs: { ...ARGS, content: 'something else' } },
    { envelope: envelope({ approvalId: 'apr_2' }) },
    { decision: 'rejected' },
    { envelope: envelope({}, crypto.generateKeyPairSync('ed25519').privateKey) },
    { now: Date.parse('2026-10-12T12:09:00.000Z') },
    { envelope: { forged: true } },
  ];
  for (const fields of cases) {
    const result = guard(fields);
    assert.equal(result.ok, false, JSON.stringify(Object.keys(fields)));
    assert.equal(result.code, 'AUTHORITY_DECISION_INVALID');
  }
});

test('an authority that is required or installed but unusable refuses every decision', () => {
  const result = guard({ mode: { mode: 'required_unavailable', reason: 'pin_malformed' } });
  assert.deepEqual([result.ok, result.code], [false, 'AUTHORITY_UNAVAILABLE']);
  assert.match(result.message, /pin_malformed/);
});

test("an approval runs only with the authority's signed record that it was consumed", () => {
  for (const fields of [{ consumption: undefined }, { consumption: consumption({ approvalId: 'apr_2' }) },
    { consumption: consumption({ actionHash: 'd'.repeat(64) }) },
    { consumption: consumption({}, crypto.generateKeyPairSync('ed25519').privateKey) }]) {
    const result = guard(fields);
    assert.deepEqual([result.ok, result.code], [false, 'AUTHORITY_CONSUMPTION_REQUIRED'], JSON.stringify(Object.keys(fields)));
  }
  assert.equal(guard({ consumption: undefined, checkConsumption: false }).ok, true, 'the pre-flight checks the decision alone');
});

test('a rejection needs the decision but nothing consumed', () => {
  const rejected = envelope({ decision: 'rejected' });
  assert.equal(guard({ decision: 'rejected', envelope: rejected, consumption: undefined }).ok, true);
});

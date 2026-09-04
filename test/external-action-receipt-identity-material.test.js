'use strict';

/**
 * A receipt has to carry the material its identity claim rests on (#1859).
 *
 * `metadata.identity.signatureVerified` is the verdict the *sending host*
 * reached about its own capability card. A collector that reads `true` there
 * has learned nothing it did not already have to assume, which is the
 * assurance a receipt exists to remove. These tests pin the other half: the
 * detached signature travels with the receipt, the card is rebuildable from
 * the block itself, and a reader with the issuer's public key reaches its own
 * answer -- including when that answer contradicts the host's.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { evaluateAgentIdentity } = require('../lib/external-action-identity');
const {
  agentIdentityCardFromReceiptIdentity,
  generateIdentityCardKeyPair,
  signAgentIdentityCard,
  verifyReceiptIdentityCardSignature,
} = require('../lib/external-action-identity-signing');
const { buildReceiptBatch } = require('../lib/external-action-receipt-shipper');
const { ingestReceiptBatch, queryFleet } = require('../lib/external-action-receipt-collector');

const CARD = Object.freeze({
  schemaVersion: 'huqan.agent-identity-card.v1',
  agentId: 'writer-1',
  agentName: 'writer',
  agentVersion: '1.0.0',
  ownerActorId: 'acme',
  onBehalfOf: 'acme',
  workspaceId: 'default',
  capabilities: ['shell'],
  delegationChain: ['writer-1'],
  issuedAt: '2026-09-01T00:00:00.000Z',
  expiresAt: null,
});

function scratch(t, prefix) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return base;
}

/** The guard's own path: an envelope in, a persisted identity block out. */
function identityFor({ signature, trustedPublicKeys = [] } = {}) {
  const envelope = {
    kind: 'shell',
    workspaceId: 'default',
    agent: { name: 'writer', instanceId: 'writer-1', version: '1.0.0' },
    session: { id: 's-1', turnId: 't-1' },
    identityCard: { ...CARD },
    ...(signature ? { identityCardSignature: signature } : {}),
  };
  return evaluateAgentIdentity(envelope, { trustedPublicKeys, now: () => '2026-09-05T00:00:00.000Z' }).identity;
}

function receiptWith(identity, id = 'xact_1') {
  return {
    schemaVersion: 'v4-receipt-v1',
    receiptId: id,
    receiptKind: 'external_action_admission_receipt',
    decision: 'allow',
    verdict: 'allow',
    workspaceId: 'default',
    actor: identity.agentId,
    createdAt: '2026-09-05T00:00:01.000Z',
    metadata: { identity },
  };
}

test('the signature travels with the receipt, and the card is rebuildable from it', () => {
  const keys = generateIdentityCardKeyPair();
  const signature = signAgentIdentityCard(CARD, keys.privateKeyPem);
  const identity = identityFor({ signature, trustedPublicKeys: [keys.publicKeyPem] });

  assert.equal(identity.attested, true);
  assert.equal(identity.signatureVerified, true);
  assert.deepEqual(identity.cardSignature, signature);

  // Nothing had to be duplicated into the receipt: the block already holds
  // every field the signature covers.
  assert.deepEqual(agentIdentityCardFromReceiptIdentity(identity), { ...CARD, capabilities: ['shell'], delegationChain: ['writer-1'] });
  assert.equal(verifyReceiptIdentityCardSignature(identity, [keys.publicKeyPem]), true);
});

test('a reader without the key reaches "not verified", not an error', () => {
  const keys = generateIdentityCardKeyPair();
  const identity = identityFor({ signature: signAgentIdentityCard(CARD, keys.privateKeyPem), trustedPublicKeys: [keys.publicKeyPem] });

  assert.equal(verifyReceiptIdentityCardSignature(identity, []), false);
  assert.equal(verifyReceiptIdentityCardSignature(identity, [generateIdentityCardKeyPair().publicKeyPem]), false);
});

test('an edited identity block cannot be rebuilt into a card that still verifies', () => {
  const keys = generateIdentityCardKeyPair();
  const identity = identityFor({ signature: signAgentIdentityCard(CARD, keys.privateKeyPem), trustedPublicKeys: [keys.publicKeyPem] });

  // The rewrite someone would actually attempt: keep the signature, widen the
  // authority. Every one of these fields is inside the signed card.
  for (const edit of [
    { ownerActorId: 'someone-else' },
    { capabilities: ['shell', 'network'] },
    { delegationChain: ['root', 'writer-1'] },
    { expiresAt: '2030-01-01T00:00:00.000Z' },
  ]) {
    assert.equal(verifyReceiptIdentityCardSignature({ ...identity, ...edit }, [keys.publicKeyPem]), false,
      `editing ${Object.keys(edit)[0]} must break the signature`);
  }
});

test('a host that could not verify still passes the material on', () => {
  // No trusted key on the agent host: the guard records signatureVerified
  // false, but the signature is not the host's to withhold -- the collector
  // may well hold the key.
  const keys = generateIdentityCardKeyPair();
  const identity = identityFor({ signature: signAgentIdentityCard(CARD, keys.privateKeyPem), trustedPublicKeys: [] });

  assert.equal(identity.signatureVerified, false);
  assert.equal(verifyReceiptIdentityCardSignature(identity, [keys.publicKeyPem]), true,
    'the collector must be able to reach a verdict the host could not');
});

test('an unattested receipt carries no signature field at all', () => {
  const envelope = { kind: 'shell', workspaceId: 'default', agent: { name: 'writer', instanceId: 'writer-1' }, session: {} };
  const { identity } = evaluateAgentIdentity(envelope, {});
  assert.equal(identity.attested, false);
  assert.equal(Object.prototype.hasOwnProperty.call(identity, 'cardSignature'), false,
    'an absent field keeps the canonical hash of every unsigned receipt unchanged');
  assert.equal(agentIdentityCardFromReceiptIdentity(identity), null);
});

test('the collector records its own identity verdict, not the sender claim', t => {
  const store = scratch(t, 'huqan-identity-collector-');
  const keys = generateIdentityCardKeyPair();
  const signature = signAgentIdentityCard(CARD, keys.privateKeyPem);

  // Three receipts: one this store can verify, one signed by an unknown key,
  // one with no card at all.
  const verifiable = receiptWith(identityFor({ signature, trustedPublicKeys: [keys.publicKeyPem] }), 'xact_v');
  const stranger = signAgentIdentityCard(CARD, generateIdentityCardKeyPair().privateKeyPem);
  const unknown = receiptWith(identityFor({ signature: stranger }), 'xact_u');
  const bare = receiptWith(identityFor({}), 'xact_b');

  const batch = buildReceiptBatch({ tenant: { workspaceId: 'default', ownerActorId: 'acme' }, receipts: [verifiable, unknown, bare] });
  const result = ingestReceiptBatch({ batch, root: store, trustedKeys: { 'issuer-1': keys.publicKeyPem } });
  assert.equal(result.ok, true);

  const stored = fs.readFileSync(path.join(store, 'default', 'acme', 'receipts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(stored.map(line => line.collector.identitySignature), ['verified', 'unverified', 'none']);

  const fleet = queryFleet({ root: store });
  assert.deepEqual(fleet.agents[0].byIdentitySignature, { verified: 1, unverified: 1, none: 1 });
});

test('a host claim of verified does not make the collector agree', t => {
  const store = scratch(t, 'huqan-identity-disagree-');
  const keys = generateIdentityCardKeyPair();
  const identity = identityFor({ signature: signAgentIdentityCard(CARD, keys.privateKeyPem), trustedPublicKeys: [keys.publicKeyPem] });

  // The forgery this whole change exists to catch: a host asserting the card
  // was verified while the signature says otherwise. Here the signature is
  // real but the card was widened afterwards, and the claim left at `true`.
  const forged = { ...identity, capabilities: ['shell', 'network'], signatureVerified: true };
  const batch = buildReceiptBatch({ tenant: { workspaceId: 'default', ownerActorId: 'acme' }, receipts: [receiptWith(forged, 'xact_f')] });
  ingestReceiptBatch({ batch, root: store, trustedKeys: { 'issuer-1': keys.publicKeyPem } });

  const stored = JSON.parse(fs.readFileSync(path.join(store, 'default', 'acme', 'receipts.jsonl'), 'utf8').trim());
  assert.equal(stored.metadata.identity.signatureVerified, true, 'the sender claim is preserved as written');
  assert.equal(stored.collector.identitySignature, 'unverified', 'the collector must not repeat it');
});

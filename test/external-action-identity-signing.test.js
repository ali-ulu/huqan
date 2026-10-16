'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  IDENTITY_CARD_SIGNATURE_VERSION,
  SIGNATURE_ALGORITHM,
  SIGNATURE_REASONS,
  generateIdentityCardKeyPair,
  signAgentIdentityCard,
  verifyAgentIdentityCardSignature,
} = require('../lib/external-action-identity-signing');
const {
  evaluateAgentIdentity,
  normalizeAgentIdentityCard,
} = require('../lib/external-action-identity');
const { normalizeExternalActionEnvelope } = require('../lib/external-action-envelope');

const CARD_INPUT = {
  schemaVersion: 'huqan.agent-identity-card.v1',
  agentId: 'future-agent-2035',
  agentName: 'future-agent-2035',
  agentVersion: '1.4.0',
  ownerActorId: 'actor:ali',
  onBehalfOf: 'actor:ali',
  workspaceId: 'default',
  capabilities: ['file_read', 'shell'],
  delegationChain: ['future-agent-2035'],
  issuedAt: '2026-01-01T00:00:00.000Z',
  // #2505 C: expiry is required and the lifetime is capped at 24h, so cards
  // carry a real window and every guard evaluation pins `now` inside it.
  expiresAt: '2026-01-02T00:00:00.000Z',
};

const NOW = '2026-01-01T12:00:00.000Z';

function atNow(extra = {}) {
  return { now: () => NOW, ...extra };
}

function envelopeFor(overrides = {}) {
  return normalizeExternalActionEnvelope({
    schemaVersion: 'huqan.external-action.v1',
    invocationId: 'tool-call-123',
    agent: { name: 'future-agent-2035', instanceId: 'future-agent-2035' },
    session: { id: 'session-9', turnId: 'turn-4' },
    tool: { name: 'shell', kind: 'shell' },
    kind: 'shell',
    args: { command: 'git status' },
    workspaceId: 'default',
    identity: overrides.identityCard,
    identityCardSignature: overrides.identityCardSignature,
    ...overrides,
  });
}

test('anahtar çifti üretimi: ed25519 PEM çifti döner', () => {
  const pair = generateIdentityCardKeyPair();
  assert.equal(pair.algorithm, SIGNATURE_ALGORITHM);
  assert.match(pair.publicKeyPem, /BEGIN PUBLIC KEY/);
  assert.match(pair.privateKeyPem, /BEGIN PRIVATE KEY/);
});

test('imza → doğrulama turu: geçerli kart doğrulanır', () => {
  const { card } = normalizeAgentIdentityCard(CARD_INPUT);
  const { privateKeyPem, publicKeyPem } = generateIdentityCardKeyPair();
  const envelope = signAgentIdentityCard(card, privateKeyPem);
  assert.equal(envelope.schemaVersion, IDENTITY_CARD_SIGNATURE_VERSION);
  assert.equal(verifyAgentIdentityCardSignature(card, envelope, publicKeyPem), true);
});

test('kanonik imza: anahtar sırası değişse de doğrulanır', () => {
  const { card } = normalizeAgentIdentityCard(CARD_INPUT);
  const reordered = Object.fromEntries(Object.entries(card).reverse());
  const { privateKeyPem, publicKeyPem } = generateIdentityCardKeyPair();
  const envelope = signAgentIdentityCard(card, privateKeyPem);
  assert.equal(verifyAgentIdentityCardSignature(reordered, envelope, publicKeyPem), true);
});

test('fail-closed: kart alanı değişirse imza geçersiz olur', () => {
  const { card } = normalizeAgentIdentityCard(CARD_INPUT);
  const { privateKeyPem, publicKeyPem } = generateIdentityCardKeyPair();
  const envelope = signAgentIdentityCard(card, privateKeyPem);
  const mutated = { ...card, ownerActorId: 'actor:someone-else' };
  assert.equal(verifyAgentIdentityCardSignature(mutated, envelope, publicKeyPem), false);
});

test('fail-closed: bozuk zarf, yanlış algoritma, hatalı imza gövdesi doğrulanmaz', () => {
  const { card } = normalizeAgentIdentityCard(CARD_INPUT);
  const { publicKeyPem } = generateIdentityCardKeyPair();
  assert.equal(verifyAgentIdentityCardSignature(card, null, publicKeyPem), false);
  assert.equal(verifyAgentIdentityCardSignature(card, 'not-an-envelope', publicKeyPem), false);
  assert.equal(
    verifyAgentIdentityCardSignature(card, { schemaVersion: 'huqan.other.v1', algorithm: 'ed25519', signature: 'AAAA' }, publicKeyPem),
    false,
  );
  assert.equal(
    verifyAgentIdentityCardSignature(card, { schemaVersion: IDENTITY_CARD_SIGNATURE_VERSION, algorithm: 'rsa', signature: 'AAAA' }, publicKeyPem),
    false,
  );
  assert.equal(
    verifyAgentIdentityCardSignature(card, { schemaVersion: IDENTITY_CARD_SIGNATURE_VERSION, algorithm: 'ed25519', signature: '!!!base64 degil!!!' }, publicKeyPem),
    false,
  );
  assert.equal(
    verifyAgentIdentityCardSignature(card, { schemaVersion: IDENTITY_CARD_SIGNATURE_VERSION, algorithm: 'ed25519', signature: Buffer.alloc(32).toString('base64') }, publicKeyPem),
    false,
  );
  assert.equal(verifyAgentIdentityCardSignature(card, null, 'bu bir anahtar degil'), false);
  assert.equal(verifyAgentIdentityCardSignature(null, null, publicKeyPem), false);
});

test('fail-closed: symbol anahtarlı zarf istisna değil doğrulama hatası üretir', () => {
  // Regresyon: parseSignatureEnvelope Reflect.ownKeys kullanırken symbol'ler de
  // listeye giriyordu ve TAM ÜÇ anahtarlı zarfta uzunluk kontrolü kısa devre
  // yapmadığı için .sort() "Cannot convert a Symbol value to a string" atıyordu.
  // Modülün sözleşmesi bozuk girdide istisna değil false; çağıran try/catch
  // yazmak zorunda kalmamalı.
  const { card } = normalizeAgentIdentityCard(CARD_INPUT);
  const { publicKeyPem } = generateIdentityCardKeyPair();
  const zarf = {
    algorithm: SIGNATURE_ALGORITHM,
    schemaVersion: IDENTITY_CARD_SIGNATURE_VERSION,
    [Symbol('signature')]: 'AAAA',
  };

  assert.equal(verifyAgentIdentityCardSignature(card, zarf, publicKeyPem), false);
});

test('yanlış anahtar doğrulamaz, doğru anahtar doğrular', () => {
  const { card } = normalizeAgentIdentityCard(CARD_INPUT);
  const signer = generateIdentityCardKeyPair();
  const other = generateIdentityCardKeyPair();
  const envelope = signAgentIdentityCard(card, signer.privateKeyPem);
  assert.equal(verifyAgentIdentityCardSignature(card, envelope, other.publicKeyPem), false);
  assert.equal(verifyAgentIdentityCardSignature(card, envelope, signer.publicKeyPem), true);
});

test('guard: güvenilir anahtarla imzalı kart signatureVerified: true ve allow', () => {
  const { card } = normalizeAgentIdentityCard(CARD_INPUT);
  const { privateKeyPem, publicKeyPem } = generateIdentityCardKeyPair();
  const envelope = signAgentIdentityCard(card, privateKeyPem);
  const result = evaluateAgentIdentity(envelopeFor({ identityCard: card, identityCardSignature: envelope }), atNow({
    trustedPublicKeys: [publicKeyPem],
  }));
  assert.equal(result.identity.signatureVerified, true);
  assert.equal(result.identity.attested, true);
  assert.equal(result.finding.decision, 'allow');
  assert.equal(result.finding.reason, 'agent_identity_attested');
});

test('guard: imza zorunlu ve imza yoksa block (missing)', () => {
  const { card } = normalizeAgentIdentityCard(CARD_INPUT);
  const { publicKeyPem } = generateIdentityCardKeyPair();
  const result = evaluateAgentIdentity(envelopeFor({ identityCard: card }), atNow({
    trustedPublicKeys: [publicKeyPem],
    requireSignedIdentityCard: true,
  }));
  assert.equal(result.finding.decision, 'block');
  assert.equal(result.finding.reason, SIGNATURE_REASONS.MISSING);
  assert.equal(result.identity.signatureVerified, false);
});

test('guard: imza zorunlu ve imza geçersizse block (invalid)', () => {
  const { card } = normalizeAgentIdentityCard(CARD_INPUT);
  const { publicKeyPem } = generateIdentityCardKeyPair();
  const result = evaluateAgentIdentity(envelopeFor({
    identityCard: card,
    identityCardSignature: { schemaVersion: IDENTITY_CARD_SIGNATURE_VERSION, algorithm: 'ed25519', signature: Buffer.alloc(64).toString('base64') },
  }), atNow({
    trustedPublicKeys: [publicKeyPem],
    requireSignedIdentityCard: true,
  }));
  assert.equal(result.finding.decision, 'block');
  assert.equal(result.finding.reason, SIGNATURE_REASONS.INVALID);
});

test('guard: imzasız kart varsayılanda artık block — kartsız attestasyon kabul edilmez', () => {
  // #2505 C: the default flipped from allow to block. A card that makes no
  // verifiable claim is no longer an attestation, so the guard refuses it
  // until the deployment opts out explicitly.
  const { card } = normalizeAgentIdentityCard(CARD_INPUT);
  const result = evaluateAgentIdentity(envelopeFor({ identityCard: card }), atNow({}));
  assert.equal(result.finding.decision, 'block');
  assert.equal(result.finding.reason, SIGNATURE_REASONS.MISSING);
  assert.equal(result.identity.signatureVerified, false);
  assert.equal(result.identity.attested, true);
});

test('guard: review zorunluluğu review kararı verir', () => {
  const { card } = normalizeAgentIdentityCard(CARD_INPUT);
  const result = evaluateAgentIdentity(envelopeFor({ identityCard: card }), atNow({
    requireSignedIdentityCard: 'review',
  }));
  assert.equal(result.finding.decision, 'review');
  assert.equal(result.finding.reason, SIGNATURE_REASONS.MISSING);
});

test('guard: açık opt-out imzasız kartı yine allow eder, signatureVerified false kalır', () => {
  const { card } = normalizeAgentIdentityCard(CARD_INPUT);
  const result = evaluateAgentIdentity(envelopeFor({ identityCard: card }), atNow({
    requireIdentityCard: false,
    requireSignedIdentityCard: false,
  }));
  assert.equal(result.finding.decision, 'allow');
  assert.equal(result.identity.signatureVerified, false);
  assert.equal(result.identity.attested, true);
});

test('guard: environment bayrağı zorunluluğu açar', () => {
  const { card } = normalizeAgentIdentityCard(CARD_INPUT);
  const result = evaluateAgentIdentity(envelopeFor({ identityCard: card }), atNow({
    environment: { HUQAN_EXTERNAL_GUARD_REQUIRE_SIGNED_IDENTITY: '1' },
  }));
  assert.equal(result.finding.decision, 'block');
  const review = evaluateAgentIdentity(envelopeFor({ identityCard: card }), atNow({
    environment: { HUQAN_EXTERNAL_GUARD_REQUIRE_SIGNED_IDENTITY: 'review' },
  }));
  assert.equal(review.finding.decision, 'review');
});

test('guard: zarf normalizasyonu identityCardSignature alanını taşır', () => {
  const signature = { schemaVersion: IDENTITY_CARD_SIGNATURE_VERSION, algorithm: 'ed25519', signature: 'AAAA' };
  const envelope = envelopeFor({ identityCardSignature: signature });
  assert.deepEqual(envelope.identityCardSignature, signature);
  assert.equal(envelopeFor({}).identityCardSignature, null);
});

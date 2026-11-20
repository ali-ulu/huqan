'use strict';

/**
 * #4624 — the acceptance-oracle channel cannot be forged by a bare environment
 * variable. Independence has to be a property of a *signer*: the approval
 * authority mints an Ed25519 decision envelope over the exact evidence, and
 * `verifyAcceptanceAttestation` checks it against the pinned key.
 *
 * These tests exercise the verifier directly, so each refusal is attributed to
 * the single fact it is about: no attestation, a malformed one, an untrusted
 * key, evidence that does not match what was signed, and an expired grant.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  ATTESTATION_TOOL, CODES, CHANNELS, acceptanceActionHash, allowedPathsHash,
  verifyAcceptanceAttestation,
} = require('../lib/experience/acceptance-attestation');
const { signDecision, DECISION_VERSION } = require('../lib/authority/decision-envelope');

const AUTHORITY = crypto.generateKeyPairSync('ed25519');
const OTHER = crypto.generateKeyPairSync('ed25519');
const NOW = Date.parse('2026-11-20T09:30:00.000Z');
const at = offset => new Date(NOW + offset).toISOString();

const SOURCE_HASH = crypto.createHash('sha256').update('failure-record', 'utf8').digest('hex');
const COMMAND = 'node --test test/version.test.js';
const PATHS = ['docs/version.md'];

const WORKSPACE = 'default';
const APPROVAL = 'acceptance-1';

function evidence(overrides = {}) {
  return {
    sourceHash: SOURCE_HASH,
    commandHash: crypto.createHash('sha256').update(COMMAND, 'utf8').digest('hex'),
    allowedPathsHash: allowedPathsHash(PATHS),
    channel: 'ci',
    approvalId: APPROVAL,
    workspaceId: WORKSPACE,
    ...overrides,
  };
}

function mint({
  channel = 'ci', key = AUTHORITY.privateKey, decidedAt = at(-60_000), validUntil = at(9 * 60_000),
  approvalId = APPROVAL, workspaceId = WORKSPACE, tool = ATTESTATION_TOOL,
  actionHash = acceptanceActionHash(evidence({ channel, approvalId, workspaceId })),
} = {}) {
  const envelope = signDecision({
    v: DECISION_VERSION, approvalId, workspaceId, tool, actionHash,
    decision: 'approved', reason: '', decidedAt, validUntil, ledgerSeq: 4,
    ledgerHash: 'c'.repeat(64), operator: 'totp:primary',
  }, key);
  return { channel, envelope };
}

function verify(attestation, overrides = {}) {
  return verifyAcceptanceAttestation(attestation, {
    sourceHash: SOURCE_HASH, command: COMMAND, allowedPaths: PATHS,
    trustedKey: AUTHORITY.publicKey, workspaceId: WORKSPACE, now: NOW, ...overrides,
  });
}

test('a decision the authority signed over this evidence verifies', () => {
  const result = verify(mint());
  assert.equal(result.ok, true);
  assert.equal(result.channel, 'ci');
  assert.equal(result.approvalId, 'acceptance-1');
  assert.match(result.actionHash, /^[0-9a-f]{64}$/u);
});

test('no attestation, a non-object and an unusable clock all refuse', () => {
  assert.equal(verify(undefined).code, CODES.MISSING);
  assert.equal(verify(null).code, CODES.MISSING);
  assert.equal(verify('signed, honest').code, CODES.MALFORMED);
  assert.equal(verify(mint(), { now: Number.NaN }).code, CODES.MALFORMED);
});

test('without a pinned key nothing can prove authorship', () => {
  // The finding in one line: an attestation is not "weaker" without a trust
  // anchor, it is unverifiable, and unverifiable is refused rather than trusted.
  for (const trustedKey of [undefined, null, '']) {
    assert.equal(verify(mint(), { trustedKey }).code, CODES.UNTRUSTED, String(trustedKey));
  }
});

test('a self-written attestation is refused because the key is not the pin', () => {
  // The attack #4624 describes, moved one layer down: the proposer mints its
  // own keypair and signs its own "independent" channel. The signature is
  // perfectly valid -- over the wrong key.
  const selfSigned = mint({ key: OTHER.privateKey });
  const result = verify(selfSigned);
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.BINDING_MISMATCH);
  assert.equal(result.detail, 'key_mismatch');
});

test('an attestation binds exactly the evidence it was signed for', () => {
  const attestation = mint();

  const wrongSource = verify(attestation, { sourceHash: 'd'.repeat(64) });
  assert.equal(wrongSource.code, CODES.BINDING_MISMATCH);

  const wrongCommand = verify(attestation, { command: 'node --test test/other.test.js' });
  assert.equal(wrongCommand.code, CODES.BINDING_MISMATCH);

  const widerPaths = verify(attestation, { allowedPaths: ['docs/version.md', 'docs/other.md'] });
  assert.equal(widerPaths.code, CODES.BINDING_MISMATCH);

  // Reordered paths are the same grant: the hash is order-insensitive.
  const reordered = verify(attestation, { allowedPaths: ['docs/other.md', 'docs/version.md'] });
  assert.equal(reordered.ok, false, 'a wider set is not the same set');

  const sameSet = verify(mint(), { allowedPaths: ['docs/version.md'] });
  assert.equal(sameSet.ok, true);
});

test('a decision minted for another tool cannot be presented as an attestation', () => {
  // Domain separation: the acceptance attestation names its own tool, so a
  // promotion decision replayed here is refused rather than accepted as an
  // oracle grant.
  const asPromotion = mint({ tool: 'huqan.reflective_promotion' });
  const result = verify(asPromotion);
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.BINDING_MISMATCH);
});

test('an expired grant is refused as expired, not as a forgery', () => {
  const stale = mint({ decidedAt: at(-9 * 60_000), validUntil: at(-8 * 60_000) });
  const result = verify(stale);
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.EXPIRED);
  assert.equal(result.detail, 'expired');
});

test('a malformed channel or missing evidence refuses before any signature check', () => {
  assert.equal(verify({ ...mint(), channel: 'agent' }).code, CODES.MALFORMED);
  assert.equal(verify({ ...mint(), channel: '' }).code, CODES.MALFORMED);
  assert.equal(verify(mint(), { command: '' }).code, CODES.MALFORMED);
  assert.equal(verify(mint(), { allowedPaths: [] }).code, CODES.MALFORMED);
  assert.equal(verify(mint(), { sourceHash: 'not-a-hash' }).code, CODES.MALFORMED);
});

test('the signed channel vocabulary is closed and includes source-file on purpose', () => {
  // `source-file` is attestable so the learning layer can refuse it by name
  // with `oracle_not_independent` instead of reporting a forgery. Independence
  // is decided one layer up, where exactly one fact is refused at a time.
  assert.deepEqual([...CHANNELS], ['operator', 'ci', 'source-file']);
  const fromFile = verify(mint({ channel: 'source-file' }));
  assert.equal(fromFile.ok, true);
  assert.equal(fromFile.channel, 'source-file');
});

test('the action hash covers the tool, so two evidence shapes never collide', () => {
  const base = evidence();
  const hash = acceptanceActionHash(base);
  assert.match(hash, /^[0-9a-f]{64}$/u);
  assert.equal(acceptanceActionHash({ ...base, channel: 'operator' }) === hash, false);
  assert.equal(acceptanceActionHash({ ...base, sourceHash: 'e'.repeat(64) }) === hash, false);
  // The workspace and the approval are inside the hash: a grant for one
  // workspace is not a grant for another.
  assert.equal(acceptanceActionHash({ ...base, workspaceId: 'other' }) === hash, false);
  assert.equal(acceptanceActionHash({ ...base, approvalId: 'acceptance-2' }) === hash, false);
  assert.equal(acceptanceActionHash({ ...base, channel: 'nope' }), null);
  assert.equal(acceptanceActionHash({ ...base, commandHash: '' }), null);
  // Order-insensitivity is a property of the path hash, not the action hash.
  assert.equal(allowedPathsHash(['a.js', 'b.js']), allowedPathsHash(['b.js', 'a.js']));
  assert.equal(allowedPathsHash([]), null);
});

test('a registration through the real authority path produces an attestation that verifies', () => {
  // The finding: registration hashed {tool, workspaceId, approvalId, arguments}
  // while the verifier hashed only the evidence, so no envelope the documented
  // workflow could mint ever verified. This drives the real registration and
  // validation code instead of minting a hand-built hash, so the two recipes
  // are compared rather than assumed equal.
  const { validateRegistration } = require('../lib/authority/approval-registration');
  const { buildOperationalRegistration } = require('../lib/authority/registration-payload');
  const { OPERATIONAL_TOOLS } = require('../lib/authority/operational-guard');
  const { acceptanceArguments } = require('../lib/experience/acceptance-attestation');

  assert.equal(OPERATIONAL_TOOLS.ACCEPTANCE_ORACLE, ATTESTATION_TOOL,
    'the acceptance oracle must be registrable with the authority, or the workflow stops at request');

  const args = acceptanceArguments(evidence());
  assert.ok(args, 'the evidence must be registrable');
  const body = buildOperationalRegistration({
    tool: ATTESTATION_TOOL, workspaceId: WORKSPACE, args,
    consumeKey: crypto.randomBytes(32), now: NOW, ttlMs: 10 * 60_000,
  });
  const validated = validateRegistration(body, NOW);
  assert.equal(validated.ok, true, `registration must validate: ${JSON.stringify(validated)}`);

  const envelope = signDecision({
    v: DECISION_VERSION, approvalId: body.approvalId, workspaceId: WORKSPACE, tool: body.tool,
    actionHash: body.actionHash, decision: 'approved', reason: '', decidedAt: at(-60_000),
    validUntil: at(9 * 60_000), ledgerSeq: 7, ledgerHash: 'd'.repeat(64), operator: 'totp:primary',
  }, AUTHORITY.privateKey);

  const result = verify({ channel: 'ci', envelope });
  assert.equal(result.ok, true, `the registered grant must verify: ${JSON.stringify(result)}`);
  assert.equal(result.approvalId, body.approvalId);
  assert.equal(result.workspaceId, WORKSPACE);
});

test('a grant for one workspace does not authorize a failure from another', () => {
  // The finding: the workspace check compared the envelope with itself, so an
  // approval for A passed for any failure. The workspace now comes from the
  // caller (which reads it from the failure record), so a mismatch refuses.
  const forDefault = mint();
  assert.equal(verify(forDefault, { workspaceId: 'default' }).ok, true);
  const result = verify(forDefault, { workspaceId: 'other' });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.BINDING_MISMATCH);

  // A missing workspace is refused rather than defaulted: an unscoped grant is
  // a grant to every workspace.
  assert.equal(verify(forDefault, { workspaceId: undefined }).code, CODES.MALFORMED);
  assert.equal(verify(forDefault, { workspaceId: '' }).code, CODES.MALFORMED);
});

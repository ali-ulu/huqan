'use strict';

/**
 * R54 (#3619) — rule identity on gate receipts and rule-version binding in the
 * receipt chain.
 *
 * A receipt must be able to say which rule version decided it, its chain must
 * commit to that identity, and a chain must refuse a receipt whose rule
 * identity is missing or whose rule changed version mid-chain.
 *
 * The identity lives at `metadata.ruleIdentity` (the hashed, additive home) so
 * the frozen v1 canonical schema is untouched (ADR-009).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RECEIPT_RULE_IDENTITY_LIMIT,
  RULE_IDENTITY_CHAIN_REASONS,
  receiptRuleIdentity,
  hasRuleIdentity,
  readReceiptRuleIdentity,
  attachReceiptRuleIdentity,
  assertReceiptRuleIdentity,
  ruleIdentityFingerprint,
  validateRuleIdentityChain,
} = require('../lib/receipt-rule-identity');
const {
  GENESIS_PREVIOUS_HASH,
  appendReceiptToChain,
  validateReceiptChain,
} = require('../lib/receipt/receipt-chain');
const { buildCanonicalReceiptPayload, hashCanonicalReceiptPayload } = require('../lib/receipt/canonical-receipt');
const { evaluateMemoryAdmission } = require('../lib/memory-admission-gate');
const { buildExternalActionAdmissionReceipt } = require('../lib/external-action-receipt');
const { normalizeExternalActionEnvelope } = require('../lib/external-action-envelope');

function memoryReceipt(overrides = {}) {
  const result = evaluateMemoryAdmission({
    workspaceId: 'default',
    actor: 'tester',
    agentId: 'tester',
    memoryDraftId: 'draft-1',
    provenanceId: 'prov-1',
    reason: 'write memory',
    trustPolicyVersion: '2026-06',
    proposedMemory: { content: 'fact' },
    ...overrides,
  });
  return result.receipt;
}

function canonicalFromReceipt(receipt) {
  return buildCanonicalReceiptPayload(receipt, { verdict: 'allow' });
}

test('every memory admission receipt carries a bounded rule identity', () => {
  const receipt = memoryReceipt();
  const identity = receipt.metadata.ruleIdentity;
  assert.ok(identity, 'a receipt must name the rule that decided it');
  assert.equal(typeof identity.policyVersion, 'string');
  assert.equal(identity.policyVersion.length > 0, true);
  assert.equal(identity.ruleId.length > 0, true);
  assert.equal(identity.instanceId, receipt.receiptId);
  assert.deepEqual(Object.keys(identity).sort(), ['instanceId', 'policyVersion', 'ruleId']);
});

test('every external-action admission receipt carries a bounded rule identity', () => {
  const env = normalizeExternalActionEnvelope({
    invocationId: 'inv-r54-1',
    workspaceId: 'default',
    agent: { name: 'codex', version: '1' },
    action: { kind: 'shell', command: 'npm test' },
  });
  const receipt = buildExternalActionAdmissionReceipt(env, {
    decision: 'allow',
    reason: 'allowlisted',
    risk: { level: 'low', score: 1 },
    findings: [],
  }, { now: () => '2026-09-04T00:00:00.000Z' });
  assert.equal(receipt.metadata.ruleIdentity.policyVersion, 'huqan-external-action-guard-v1');
  assert.equal(receipt.metadata.ruleIdentity.ruleId, 'allowlisted');
  assert.equal(receipt.metadata.ruleIdentity.instanceId, receipt.receiptId);
});

test('the rule identity is covered by the canonical receipt hash', () => {
  const receipt = memoryReceipt();
  const base = canonicalFromReceipt(receipt);
  const a = hashCanonicalReceiptPayload(base);
  const changedRule = canonicalFromReceipt({
    ...receipt,
    metadata: { ...receipt.metadata, ruleIdentity: { ...receipt.metadata.ruleIdentity, ruleId: 'other_rule' } },
  });
  assert.notEqual(a, hashCanonicalReceiptPayload(changedRule), 'a changed ruleId must change the receipt hash');
  const changedVersion = canonicalFromReceipt({
    ...receipt,
    metadata: { ...receipt.metadata, ruleIdentity: { ...receipt.metadata.ruleIdentity, policyVersion: 'next' } },
  });
  assert.notEqual(a, hashCanonicalReceiptPayload(changedVersion), 'a changed policyVersion must change the receipt hash');
});

test('an identity missing its rule or version is refused, never silently accepted', () => {
  assert.throws(() => assertReceiptRuleIdentity({ policyVersion: 'v1' }), /requires ruleId/);
  assert.throws(() => assertReceiptRuleIdentity({ ruleId: 'r' }), /requires policyVersion/);
  assert.throws(() => assertReceiptRuleIdentity(null), /is required/);
  assert.equal(hasRuleIdentity({ ruleId: 'r' }), false);
  assert.equal(hasRuleIdentity({ policyVersion: 'v1', ruleId: 'r' }), true);
});

test('rule identity text is bounded so a caller cannot inflate a receipt', () => {
  const long = 'x'.repeat(RECEIPT_RULE_IDENTITY_LIMIT + 100);
  const identity = receiptRuleIdentity({ policyVersion: long, ruleId: long });
  assert.equal(identity.policyVersion.length, RECEIPT_RULE_IDENTITY_LIMIT);
  assert.equal(identity.ruleId.length, RECEIPT_RULE_IDENTITY_LIMIT);
});

test('a built receipt identity is read back from metadata, and a flat record from its top level', () => {
  const nested = { metadata: { ruleIdentity: { policyVersion: 'v1', ruleId: 'r', instanceId: 'i' } } };
  assert.deepEqual(readReceiptRuleIdentity(nested), { policyVersion: 'v1', ruleId: 'r', instanceId: 'i' });
  const flat = { policyVersion: 'v2', ruleId: 'r2', instanceId: 'i2' };
  assert.deepEqual(readReceiptRuleIdentity(flat), { policyVersion: 'v2', ruleId: 'r2', instanceId: 'i2' });
});

test('attachReceiptRuleIdentity refuses an incomplete identity rather than writing a partial one', () => {
  const receipt = { receiptId: 'r', metadata: { source: 'x' } };
  attachReceiptRuleIdentity(receipt, { policyVersion: 'v1', ruleId: 'rule', instanceId: 'r' });
  assert.deepEqual(receipt.metadata.ruleIdentity, { policyVersion: 'v1', ruleId: 'rule', instanceId: 'r' });
  assert.equal(receipt.metadata.source, 'x', 'other metadata is preserved');
  assert.throws(() => attachReceiptRuleIdentity({}, { ruleId: 'rule' }), /requires policyVersion/);
});

test('a chain of receipts sharing one rule version binds cleanly', () => {
  const records = [1, 2, 3].map((n) => ({
    metadata: { ruleIdentity: { policyVersion: 'policy-1', ruleId: 'admission_rule', instanceId: `r-${n}` } },
  }));
  assert.deepEqual(validateRuleIdentityChain(records), { valid: true, brokenAt: null, reason: null });
});

test('a chain is refused when a receipt cannot name its rule', () => {
  const records = [
    { metadata: { ruleIdentity: { policyVersion: 'policy-1', ruleId: 'admission_rule', instanceId: 'r-1' } } },
    { metadata: { ruleIdentity: { instanceId: 'r-2' } } },
  ];
  const verdict = validateRuleIdentityChain(records);
  assert.equal(verdict.valid, false);
  assert.equal(verdict.brokenAt, 1);
  assert.equal(verdict.reason, RULE_IDENTITY_CHAIN_REASONS.MISSING_RULE_IDENTITY);
});

test('a chain is refused when the same rule changes version mid-chain', () => {
  const records = [
    { metadata: { ruleIdentity: { policyVersion: 'policy-1', ruleId: 'admission_rule', instanceId: 'r-1' } } },
    { metadata: { ruleIdentity: { policyVersion: 'policy-2', ruleId: 'admission_rule', instanceId: 'r-2' } } },
  ];
  const verdict = validateRuleIdentityChain(records);
  assert.equal(verdict.valid, false);
  assert.equal(verdict.brokenAt, 1);
  assert.equal(verdict.reason, RULE_IDENTITY_CHAIN_REASONS.RULE_VERSION_CHANGED);
});

test('validateReceiptChain binds rule identity only when asked, and reads the metadata identity', () => {
  const first = appendReceiptToChain(canonicalFromReceipt(memoryReceipt()));
  const second = appendReceiptToChain(
    canonicalFromReceipt(memoryReceipt({ memoryDraftId: 'draft-2', provenanceId: 'prov-2' })),
    first.receiptHash,
  );
  const chain = [first, second];
  // Default: hash/link only, unchanged for existing callers.
  assert.deepEqual(validateReceiptChain(chain), { valid: true, brokenAt: null, reason: null });
  // Opt-in: both receipts carry a real rule identity in metadata.
  assert.deepEqual(validateReceiptChain(chain, { requireRuleIdentity: true }), { valid: true, brokenAt: null, reason: null });
});

test('validateReceiptChain with requireRuleIdentity refuses a receipt whose rule version changed', () => {
  const first = appendReceiptToChain(canonicalFromReceipt(memoryReceipt()));
  const tampered = canonicalFromReceipt(memoryReceipt({ memoryDraftId: 'draft-2', provenanceId: 'prov-2' }));
  tampered.metadata.ruleIdentity = { ...tampered.metadata.ruleIdentity, policyVersion: 'policy-2' };
  const second = appendReceiptToChain(tampered, first.receiptHash);
  const verdict = validateReceiptChain([first, second], { requireRuleIdentity: true });
  assert.equal(verdict.valid, false);
  assert.equal(verdict.brokenAt, 1);
  assert.equal(verdict.reason, RULE_IDENTITY_CHAIN_REASONS.RULE_VERSION_CHANGED);
});

test('a fingerprint names the rule version without reconstructing it', () => {
  const a = ruleIdentityFingerprint({ policyVersion: 'v1', ruleId: 'r' });
  const b = ruleIdentityFingerprint({ policyVersion: 'v1', ruleId: 'r' });
  const c = ruleIdentityFingerprint({ policyVersion: 'v2', ruleId: 'r' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[a-f0-9]{32}$/);
});

test('receipt-chain exposes the rule-identity reasons and the genesis marker is unchanged', () => {
  const chain = require('../lib/receipt/receipt-chain');
  assert.equal(chain.GENESIS_PREVIOUS_HASH, GENESIS_PREVIOUS_HASH);
  assert.deepEqual(chain.RULE_IDENTITY_CHAIN_REASONS, RULE_IDENTITY_CHAIN_REASONS);
});

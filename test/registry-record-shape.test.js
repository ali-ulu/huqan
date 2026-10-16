'use strict';

/**
 * Issue #1787 (Faz F) - registry record shape and its receiver-owned admission.
 *
 * The gap this unit closes is stated in the issue as "sertifika var, CA yok":
 * signed delegation works, but there is no in-protocol way to learn the other
 * side's key, so every trust relationship is hand-fed into an authority file.
 *
 * This file locks the first bounded step from
 * docs/v5/v5-registry-record-shape.md: a record whose every field is
 * receiver-owned. The property under test is not "a registration succeeds" but
 * the inverse - that a plausible-looking registration the receiver has no
 * independent record of is refused. Self-assertion is the exact failure the
 * unit exists to prevent, so most of these tests are rejection tests.
 *
 * Deliberately NOT covered here, because they are separate units: publication /
 * discovery surface, revocation distribution, federation across authorities.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  admitRegistryRecord,
  resolveRegistryRecordForRead,
  REGISTRY_RECORD_FIELDS,
} = require('../lib/registry/registry-record-shape');

const EVALUATION_TIME = '2026-09-03T12:00:00.000Z';

/** A 44-byte SPKI DER blob is what the trusted-key resolver admits as a key. */
function publicKey(fill = 7) {
  return Buffer.alloc(44, fill);
}

/**
 * The receiver's own view of who exists. Registration is checked against this
 * and never against the request body.
 */
function authorityFixture() {
  return {
    authorityId: 'authority-receiver-1',
    expectedTarget: {
      agentId: 'agent-receiver',
      identityRef: 'identity:receiver',
      identityHash: 'hash-receiver',
      workspaceId: 'default',
    },
    identities: [
      {
        ref: 'identity:worker-1',
        record: { agent_id: 'agent-worker-1', workspace_id: 'default' },
      },
      {
        ref: 'identity:worker-2',
        record: { agent_id: 'agent-worker-2', workspace_id: 'other-workspace' },
      },
    ],
  };
}

function trustedKeyRecords(status = 'active', extra = {}) {
  return [{
    keyReference: 'test-key:worker-1',
    status,
    publicKeySpkiDer: publicKey(),
    ...extra,
  }];
}

function validRequest(overrides = {}) {
  return {
    agentId: 'agent-worker-1',
    identityRef: 'identity:worker-1',
    workspaceId: 'default',
    protocolVersion: '0.2',
    capabilityIds: ['exchange'],
    trustRootReference: 'test-key:worker-1',
    ...overrides,
  };
}

function admit(overrides = {}) {
  return admitRegistryRecord({
    request: validRequest(),
    authority: authorityFixture(),
    existingRecord: null,
    evaluationTime: EVALUATION_TIME,
    receiverCapabilityIds: ['exchange', 'tasks'],
    supportedProtocolVersions: ['0.2'],
    trustedKeyRecords: trustedKeyRecords(),
    ...overrides,
  });
}

test('a registration matching a receiver-held identity is admitted as a bounded record', () => {
  const result = admit();

  assert.equal(result.ok, true, result.reasonCategory);
  assert.deepEqual(result.record, {
    agentId: 'agent-worker-1',
    identityRef: 'identity:worker-1',
    workspaceId: 'default',
    protocolVersion: '0.2',
    capabilityIds: ['exchange'],
    recordVersion: 1,
    authenticationRequired: true,
    trustRootReference: 'test-key:worker-1',
    resolvedKeyState: 'active',
    resolvedReasonCategory: '',
  });
});

test('the record carries the five declared groups and nothing else', () => {
  const result = admit();

  assert.deepEqual(Object.keys(result.record).sort(), [...REGISTRY_RECORD_FIELDS].sort());
  // Named explicitly because the design doc lists them as absent on purpose:
  // identityHash is a disclosure decision this unit does not make, and expiry
  // belongs to the key record, which is re-resolved per access.
  for (const absent of ['identityHash', 'expiresAt', 'endpoints', 'publicKeySpkiDer']) {
    assert.equal(Object.hasOwn(result.record, absent), false, `${absent} must not be stored`);
  }
});

test('the admitted record is frozen, so a caller cannot edit an admission after the fact', () => {
  const { record } = admit();

  assert.equal(Object.isFrozen(record), true);
  assert.throws(() => { record.recordVersion = 99; }, TypeError);
});

test('a self-asserted identity the receiver holds no record of fails closed', () => {
  const result = admit({
    request: validRequest({ agentId: 'agent-stranger', identityRef: 'identity:stranger' }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCategory, 'identity_not_receiver_held');
  assert.equal(Object.hasOwn(result, 'record'), false, 'a rejection must leave no partial record');
});

test('a held identityRef paired with another record agentId fails closed', () => {
  // The fields must match the SAME receiver-held entry. Checking them
  // independently would let a caller stitch a new identity out of two real
  // ones, which is self-assertion wearing borrowed parts.
  const result = admit({
    request: validRequest({ agentId: 'agent-worker-2' }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCategory, 'identity_not_receiver_held');
});

test('a held identity registered under the wrong workspace fails closed', () => {
  const result = admit({
    request: validRequest({
      agentId: 'agent-worker-2',
      identityRef: 'identity:worker-2',
      workspaceId: 'default',
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCategory, 'identity_not_receiver_held');
});

test('the receiver own card is a valid registration target', () => {
  const result = admit({
    request: validRequest({
      agentId: 'agent-receiver',
      identityRef: 'identity:receiver',
      workspaceId: 'default',
      trustRootReference: 'test-key:receiver',
    }),
    trustedKeyRecords: [{
      keyReference: 'test-key:receiver',
      status: 'active',
      publicKeySpkiDer: publicKey(),
    }],
  });

  assert.equal(result.ok, true, result.reasonCategory);
  assert.equal(result.record.identityRef, 'identity:receiver');
});

test('capabilities outside the receiver own offer are refused', () => {
  const result = admit({
    request: validRequest({ capabilityIds: ['exchange', 'streaming-trust'] }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCategory, 'capability_not_offered');
});

test('an empty capability list is refused rather than stored as "none"', () => {
  const result = admit({ request: validRequest({ capabilityIds: [] }) });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCategory, 'capability_not_offered');
});

test('a duplicate capability id is refused rather than silently de-duplicated', () => {
  const result = admit({ request: validRequest({ capabilityIds: ['exchange', 'exchange'] }) });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCategory, 'capability_not_offered');
});

test('an unsupported protocol version is refused', () => {
  const result = admit({ request: validRequest({ protocolVersion: '0.1' }) });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCategory, 'protocol_version_unsupported');
});

for (const [status, expectedState] of [
  ['revoked', 'revoked'],
  ['expired', 'expired'],
  ['unavailable', 'unavailable'],
]) {
  test(`a ${status} trust root rejects the whole admission and stores nothing`, () => {
    const result = admit({ trustedKeyRecords: trustedKeyRecords(status) });

    assert.equal(result.ok, false);
    assert.equal(result.reasonCategory, 'trust_root_not_active');
    assert.equal(result.resolvedKeyState, expectedState);
    assert.equal(Object.hasOwn(result, 'record'), false);
  });
}

test('a trust root the receiver does not know at all fails closed as unknown', () => {
  const result = admit({ request: validRequest({ trustRootReference: 'test-key:never-seen' }) });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCategory, 'trust_root_not_active');
  assert.equal(result.resolvedKeyState, 'unknown');
});

test('a key whose expiry has passed at the receiver clock fails closed', () => {
  const result = admit({
    trustedKeyRecords: trustedKeyRecords('active', { expiresAt: '2026-09-03T11:59:59.999Z' }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCategory, 'trust_root_not_active');
  assert.equal(result.resolvedKeyState, 'expired');
});

test('re-registering a held identity bumps recordVersion instead of creating a second record', () => {
  const first = admit();
  assert.equal(first.record.recordVersion, 1);

  const second = admit({ existingRecord: first.record });

  assert.equal(second.ok, true, second.reasonCategory);
  assert.equal(second.record.recordVersion, 2);
  assert.equal(second.record.identityRef, first.record.identityRef);
});

test('recordVersion is receiver-owned and cannot be set from the request body', () => {
  const result = admit({
    request: validRequest({ recordVersion: 40, authenticationRequired: false }),
  });

  // An unknown field is a malformed request rather than an ignored one: silently
  // dropping it would let a caller believe it was honoured.
  assert.equal(result.ok, false);
  assert.equal(result.reasonCategory, 'malformed_registration_request');
});

test('an existing record for a different identity cannot raise this record version', () => {
  const other = admit({
    request: validRequest({
      agentId: 'agent-worker-2',
      identityRef: 'identity:worker-2',
      workspaceId: 'other-workspace',
      trustRootReference: 'test-key:worker-2',
    }),
    trustedKeyRecords: [{
      keyReference: 'test-key:worker-2',
      status: 'active',
      publicKeySpkiDer: publicKey(9),
    }],
  });
  assert.equal(other.ok, true, other.reasonCategory);

  const result = admit({ existingRecord: other.record });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCategory, 'record_identity_mismatch');
});

for (const bad of [
  undefined, null, 'string', 42, [],
  { agentId: 'agent-worker-1' },
  validRequest({ agentId: '' }),
  validRequest({ agentId: ' agent-worker-1' }),
  validRequest({ identityRef: 'a'.repeat(300) }),
  validRequest({ capabilityIds: 'exchange' }),
  validRequest({ capabilityIds: [1] }),
]) {
  test(`a malformed registration request is refused: ${JSON.stringify(bad)}`, () => {
    const result = admit({ request: bad });

    assert.equal(result.ok, false);
    assert.equal(result.reasonCategory, 'malformed_registration_request');
  });
}

test('a read re-resolves the trust root and still returns an active record', () => {
  const { record } = admit();

  const read = resolveRegistryRecordForRead({
    record,
    evaluationTime: EVALUATION_TIME,
    trustedKeyRecords: trustedKeyRecords(),
  });

  assert.equal(read.ok, true);
  assert.deepEqual(read.record, record);
});

test('a record whose trust root was revoked after admission is excluded at read time', () => {
  // The point of the whole issue: revocation must reach the reader without
  // anyone hand-editing a file. Re-resolving per read is what makes that true.
  const { record } = admit();

  const read = resolveRegistryRecordForRead({
    record,
    evaluationTime: EVALUATION_TIME,
    trustedKeyRecords: trustedKeyRecords('revoked'),
  });

  assert.equal(read.ok, false);
  assert.equal(read.reasonCategory, 'trust_root_not_active');
  assert.equal(read.resolvedKeyState, 'revoked');
  assert.equal(Object.hasOwn(read, 'record'), false, 'a stale admitted copy must not be returned');
});

test('a read never returns the stored resolvedKeyState when the live one disagrees', () => {
  const { record } = admit();
  const forged = { ...record, resolvedKeyState: 'active' };

  const read = resolveRegistryRecordForRead({
    record: forged,
    evaluationTime: EVALUATION_TIME,
    trustedKeyRecords: trustedKeyRecords('revoked'),
  });

  assert.equal(read.ok, false);
  assert.equal(read.resolvedKeyState, 'revoked');
});

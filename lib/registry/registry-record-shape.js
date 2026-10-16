'use strict';

/**
 * Registry record shape and its receiver-owned admission contract (#1787, Faz F).
 *
 * The problem this belongs to, in one line: signed delegation already works,
 * but there is no in-protocol way to learn the other side's key, so trust is
 * hand-fed into an authority file. That is TLS without a CA - encryption
 * works, trust is not established. A registry is the missing distribution
 * layer, and a record is its unit.
 *
 * The single invariant here is receiver ownership. No field in an admitted
 * record may originate from the registering agent's own request body where the
 * receiver holds a counterpart. The request is treated as a *claim to be
 * matched*, never as content to be stored: identity is matched against what
 * the receiver already holds, capabilities against what the receiver itself
 * offers, and the trust root through the receiver's own key resolver. A
 * registration the receiver cannot independently corroborate is refused, and
 * the refusal is whole - there is no partial record.
 *
 * Two consequences worth stating because they look like strictness for its own
 * sake:
 *
 *   - An unknown request field is a rejection, not something ignored. Silently
 *     dropping `recordVersion` from a body would let the sender believe it was
 *     honoured, and a registry that lies about what it accepted is worse than
 *     one that refuses.
 *   - The stored `resolvedKeyState` is a record of an admission, never an
 *     authorization to reuse. Reads re-resolve the trust root, which is what
 *     makes revocation reach a reader without anyone editing a file - the
 *     sharper half of the gap the issue describes.
 *
 * Scope: this module is the record and its admission decision. Persistence,
 * the HTTP surface, publication/discovery, revocation distribution and
 * federation are separate units by design (docs/v5/v5-registry-record-shape.md
 * section 3), and none of them are implemented or implied here.
 */

const { resolveTrustedKeyState } = require('../receipt/trusted-key-resolver');
const { isPlainObject } = require('../is-plain-object');

/** The five field groups a record stores, and the whole of what it stores. */
const REGISTRY_RECORD_FIELDS = Object.freeze([
  // identity
  'agentId', 'identityRef', 'workspaceId',
  // capability
  'protocolVersion', 'capabilityIds',
  // version
  'recordVersion',
  // auth requirement
  'authenticationRequired',
  // trust root
  'trustRootReference', 'resolvedKeyState', 'resolvedReasonCategory',
]);

/**
 * The request may carry exactly these. Anything else is malformed, including
 * receiver-owned names like `recordVersion` - especially those.
 */
const REQUEST_FIELDS = Object.freeze(new Set([
  'agentId', 'identityRef', 'workspaceId',
  'protocolVersion', 'capabilityIds', 'trustRootReference',
]));

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_CAPABILITY_IDS = 32;
// oxlint-disable-next-line no-control-regex -- deliberate: the control-character class this record shape rejects
const CONTROL_OR_SPACE_PATTERN = /[\s\u0000-\u001F\u007F]/;

function reject(reasonCategory, extra = {}) {
  return Object.freeze({ ok: false, reasonCategory, ...extra });
}

function isBoundedIdentifier(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_IDENTIFIER_LENGTH
    && !CONTROL_OR_SPACE_PATTERN.test(value);
}

function validateRequest(request) {
  if (!isPlainObject(request)) return null;

  const keys = Object.keys(request);
  if (keys.length !== REQUEST_FIELDS.size) return null;
  if (!keys.every((key) => REQUEST_FIELDS.has(key))) return null;

  for (const field of ['agentId', 'identityRef', 'workspaceId', 'protocolVersion', 'trustRootReference']) {
    if (!isBoundedIdentifier(request[field])) return null;
  }

  if (!Array.isArray(request.capabilityIds)) return null;
  if (request.capabilityIds.length > MAX_CAPABILITY_IDS) return null;
  if (!request.capabilityIds.every(isBoundedIdentifier)) return null;

  return request;
}

/**
 * Identity is matched against a single receiver-held entry, never field by
 * field across several. Checking the fields independently would let a caller
 * assemble a new identity out of parts of two real ones, which is
 * self-assertion wearing borrowed clothes.
 */
function matchesReceiverHeldIdentity(request, authority) {
  if (!isPlainObject(authority)) return false;

  const target = authority.expectedTarget;
  if (isPlainObject(target)
    && target.agentId === request.agentId
    && target.identityRef === request.identityRef
    && target.workspaceId === request.workspaceId) {
    return true;
  }

  const identities = Array.isArray(authority.identities) ? authority.identities : [];
  return identities.some((entry) => isPlainObject(entry)
    && entry.ref === request.identityRef
    && isPlainObject(entry.record)
    && entry.record.agent_id === request.agentId
    && entry.record.workspace_id === request.workspaceId);
}

function capabilitiesAreOffered(capabilityIds, receiverCapabilityIds) {
  // Empty is refused rather than stored as "none": a record claiming no
  // capability is a record nobody can act on, and admitting it would put a
  // meaningless row in an audit surface.
  if (capabilityIds.length === 0) return false;
  if (new Set(capabilityIds).size !== capabilityIds.length) return false;

  const offered = new Set(Array.isArray(receiverCapabilityIds) ? receiverCapabilityIds : []);
  return capabilityIds.every((id) => offered.has(id));
}

/**
 * Resolve a trust root through the receiver's own key authority.
 *
 * `active` is the only admitting state. Every other state - revoked, expired,
 * unknown, unavailable, malformed - refuses whole, and the state travels back
 * so a caller can be told which without being told anything about the key.
 */
function resolveTrustRoot(trustRootReference, evaluationTime, trustedKeyRecords) {
  const state = resolveTrustedKeyState({
    keyReference: trustRootReference,
    records: Array.isArray(trustedKeyRecords) ? trustedKeyRecords : [],
    evaluationTime,
  });

  return {
    active: state.keyState === 'active',
    keyState: state.keyState,
    reasonCategory: state.reasonCategory || '',
  };
}

/**
 * Admit a registration, or refuse it whole.
 *
 * `existingRecord` is the receiver's current record for this identity, if any.
 * A repeat registration bumps `recordVersion` on the same record rather than
 * creating a second one, so an identity has one row and a history of versions
 * rather than a pile of near-duplicates.
 */
function admitRegistryRecord({
  request,
  authority,
  existingRecord = null,
  evaluationTime,
  receiverCapabilityIds,
  supportedProtocolVersions,
  trustedKeyRecords,
} = {}) {
  const validated = validateRequest(request);
  if (validated === null) return reject('malformed_registration_request');

  if (!matchesReceiverHeldIdentity(validated, authority)) {
    return reject('identity_not_receiver_held');
  }

  const supported = Array.isArray(supportedProtocolVersions) ? supportedProtocolVersions : [];
  if (!supported.includes(validated.protocolVersion)) {
    return reject('protocol_version_unsupported');
  }

  if (!capabilitiesAreOffered(validated.capabilityIds, receiverCapabilityIds)) {
    return reject('capability_not_offered');
  }

  const trustRoot = resolveTrustRoot(validated.trustRootReference, evaluationTime, trustedKeyRecords);
  if (!trustRoot.active) {
    return reject('trust_root_not_active', {
      resolvedKeyState: trustRoot.keyState,
      resolvedReasonCategory: trustRoot.reasonCategory,
    });
  }

  const versionResult = nextRecordVersion(validated, existingRecord);
  if (versionResult.error) return reject(versionResult.error);

  return Object.freeze({
    ok: true,
    record: Object.freeze({
      agentId: validated.agentId,
      identityRef: validated.identityRef,
      workspaceId: validated.workspaceId,
      protocolVersion: validated.protocolVersion,
      capabilityIds: Object.freeze([...validated.capabilityIds]),
      recordVersion: versionResult.version,
      // Constant, not configurable: public registry records do not exist in
      // this unit, and making it a field the caller could influence would be
      // the first step to one existing by accident.
      authenticationRequired: true,
      trustRootReference: validated.trustRootReference,
      resolvedKeyState: 'active',
      resolvedReasonCategory: '',
    }),
  });
}

function nextRecordVersion(request, existingRecord) {
  if (existingRecord === null || existingRecord === undefined) return { version: 1 };
  if (!isPlainObject(existingRecord)) return { error: 'malformed_registration_request' };

  // A version is only continuous with the record it belongs to. Bumping this
  // identity's version from another identity's record would silently merge two
  // registration histories.
  if (existingRecord.identityRef !== request.identityRef
    || existingRecord.agentId !== request.agentId
    || existingRecord.workspaceId !== request.workspaceId) {
    return { error: 'record_identity_mismatch' };
  }

  const current = existingRecord.recordVersion;
  if (!Number.isSafeInteger(current) || current < 1) {
    return { error: 'malformed_registration_request' };
  }

  return { version: current + 1 };
}

/**
 * Re-resolve a stored record's trust root at read time.
 *
 * The stored `resolvedKeyState` records what was true at admission and is
 * never trusted here. Without this, a revocation would only reach whoever
 * hand-edited the authority file - the precise failure #1787 is about.
 */
function resolveRegistryRecordForRead({ record, evaluationTime, trustedKeyRecords } = {}) {
  if (!isPlainObject(record) || !isBoundedIdentifier(record.trustRootReference)) {
    return reject('malformed_registry_record');
  }

  const trustRoot = resolveTrustRoot(record.trustRootReference, evaluationTime, trustedKeyRecords);
  if (!trustRoot.active) {
    return reject('trust_root_not_active', {
      resolvedKeyState: trustRoot.keyState,
      resolvedReasonCategory: trustRoot.reasonCategory,
    });
  }

  return Object.freeze({
    ok: true,
    record: Object.freeze({ ...record, resolvedKeyState: 'active', resolvedReasonCategory: '' }),
  });
}

module.exports = Object.freeze({
  REGISTRY_RECORD_FIELDS,
  MAX_CAPABILITY_IDS,
  admitRegistryRecord,
  resolveRegistryRecordForRead,
});

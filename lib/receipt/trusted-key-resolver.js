'use strict';

// Resolves a trusted key reference to its state (active, expired, revoked,
// unknown, malformed). Value checks live in trusted-key-resolver-guards.js,
// input snapshots in trusted-key-resolver-snapshot.js (#2204).

const { isPlainObject } = require('../is-plain-object');
const { RECORD_KEYS, STATES, copyPublicKey, hasForbiddenContent, hasOnlyKeys, isBoundedIdentifier, isValidPublicKey, parseTimestamp } = require('./trusted-key-resolver-guards');
const { malformedResult, snapshotRecord, snapshotRootInput, stateResult } = require('./trusted-key-resolver-snapshot');

function validateRecord(record) {
  if (!isPlainObject(record) || !hasOnlyKeys(record, RECORD_KEYS)) {
    return false;
  }

  if (!isBoundedIdentifier(record.keyReference) || !STATES.has(record.status)) {
    return false;
  }

  if (record.expiresAt !== undefined && parseTimestamp(record.expiresAt) === null) {
    return false;
  }

  if (Object.prototype.hasOwnProperty.call(record, 'publicKeySpkiDer')
    && !isValidPublicKey(record.publicKeySpkiDer)) {
    return false;
  }

  return true;
}

function resolveTrustedKeyState(input) {
  const root = snapshotRootInput(input);
  if (root === null) {
    return malformedResult();
  }

  if (!isBoundedIdentifier(root.keyReference)) {
    return malformedResult();
  }

  const evaluationInstant = parseTimestamp(root.evaluationTime);
  if (evaluationInstant === null) {
    return malformedResult();
  }

  // Capture each record's allowed fields and public key bytes exactly once
  // before any security decision. Accessor-backed, proxy-throwing, malformed,
  // or non-plain records snapshot to null and fail closed.
  const snapshots = root.records.map(snapshotRecord);
  if (snapshots.some((snapshot) => snapshot === null)) {
    return malformedResult();
  }

  if (snapshots.some((snapshot) => hasForbiddenContent(snapshot))) {
    return malformedResult();
  }

  if (!snapshots.every(validateRecord)) {
    return malformedResult();
  }

  const matches = snapshots.filter((snapshot) => (
    snapshot.keyReference === root.keyReference
  ));

  if (matches.length > 1) {
    return malformedResult();
  }

  if (matches.length === 0) {
    return stateResult('unknown');
  }

  const record = matches[0];

  if (record.status === 'unavailable') {
    return stateResult('unavailable');
  }

  if (record.status === 'revoked') {
    return stateResult('revoked');
  }

  if (record.status === 'unknown') {
    return stateResult('unknown');
  }

  if (record.status === 'malformed') {
    return malformedResult();
  }

  if (record.status === 'expired') {
    return stateResult('expired');
  }

  if (record.expiresAt !== undefined) {
    const expiryInstant = parseTimestamp(record.expiresAt);
    if (expiryInstant <= evaluationInstant) {
      return stateResult('expired');
    }
  }

  if (!Object.prototype.hasOwnProperty.call(record, 'publicKeySpkiDer')) {
    return malformedResult();
  }

  // `record` is the frozen snapshot; the key bytes were captured once and
  // already validated as a 44-byte Buffer/Uint8Array. Copy from that same
  // snapshot value and defensively re-check the resulting length so no path
  // can emit an active verdict carrying anything other than 44 bytes.
  const publicKeySpkiDer = copyPublicKey(record.publicKeySpkiDer);
  if (publicKeySpkiDer === null) {
    return malformedResult();
  }

  return {
    keyState: 'active',
    keyReference: root.keyReference,
    publicKeySpkiDer
  };
}

module.exports = {
  resolveTrustedKeyState
};

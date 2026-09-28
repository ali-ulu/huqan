'use strict';

// Shared constants and helpers for lib/huqan-package-format.js (#3089). Moved
// verbatim; the validators live in lib/huqan-package-format-validators.js and
// the entry stays the public require target.
const { ATP_OBJECT_TYPES } = require('./atp-conformance');
const { isPlainObject } = require('./is-plain-object');

const AXIOM_PACKAGE_FORMAT_VERSION = '0.1';
const HUQAN_PACKAGE_FORMAT_VERSION = '0.2';
const SUPPORTED_ATP_VERSION = '0.1';
const SUPPORTED_PROTOCOL_VERSION = '0.1';
// One row per embedded collection: its ATP type and its id field (#2200).
// OBJECT_TYPE_MAP is derived from it, so a collection cannot be added without
// saying how its objects are identified.
const PACKAGE_COLLECTIONS = Object.freeze({
  provenanceRecords: Object.freeze({ type: ATP_OBJECT_TYPES.provenanceRecord, idField: 'provenanceId' }),
  auditEvents: Object.freeze({ type: ATP_OBJECT_TYPES.auditEvent, idField: 'auditId' }),
  candidateClaims: Object.freeze({ type: ATP_OBJECT_TYPES.candidateClaim, idField: 'candidateId' }),
  conflictResults: Object.freeze({ type: ATP_OBJECT_TYPES.conflictResult, idField: 'conflictId' }),
  verificationResults: Object.freeze({ type: ATP_OBJECT_TYPES.verificationResult, idField: 'verificationId' }),
  trustReceipts: Object.freeze({ type: ATP_OBJECT_TYPES.trustReceipt, idField: 'receiptId' }),
  causalChains: Object.freeze({ type: ATP_OBJECT_TYPES.causalChain, idField: 'chainId' }),
  simulationResults: Object.freeze({ type: ATP_OBJECT_TYPES.simulationResult, idField: 'simulationId' }),
});
const OBJECT_TYPE_MAP = Object.freeze(Object.fromEntries(
  Object.entries(PACKAGE_COLLECTIONS).map(([collectionName, collection]) => [collectionName, collection.type]),
));

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function getObjectIdField(collectionName) {
  return typeof collectionName === 'string' && Object.hasOwn(PACKAGE_COLLECTIONS, collectionName)
    ? PACKAGE_COLLECTIONS[collectionName].idField
    : 'id';
}

function buildEmbeddedObjectMetadata(objects) {
  const metadata = new Map();
  if (!isPlainObject(objects)) return metadata;

  for (const [collectionName] of Object.entries(OBJECT_TYPE_MAP)) {
    const items = Array.isArray(objects[collectionName]) ? objects[collectionName] : [];
    const idField = getObjectIdField(collectionName);
    for (const item of items) {
      if (!isPlainObject(item)) continue;
      const id = item[idField];
      if (!isNonEmptyString(id)) continue;
      metadata.set(String(id), {
        type: OBJECT_TYPE_MAP[collectionName],
        workspaceId: isNonEmptyString(item.workspaceId) ? item.workspaceId.trim() : '',
        sourceRef: isNonEmptyString(item.sourceRef)
          ? item.sourceRef.trim()
          : (isPlainObject(item.provenance) && isNonEmptyString(item.provenance.sourceRef) ? item.provenance.sourceRef.trim() : ''),
      });
    }
  }

  return metadata;
}

function pushError(errors, code, field, message) {
  errors.push({ code, field, message });
}

function pushWarning(warnings, field, message) {
  warnings.push({ field, message });
}

function requiredString(errors, object, field, code = 'INVALID_AXIOM_PACKAGE') {
  if (!isPlainObject(object) || typeof object[field] !== 'string' || !object[field].trim()) {
    pushError(errors, code, field, `${field} is required`);
    return false;
  }
  return true;
}

module.exports = {
  AXIOM_PACKAGE_FORMAT_VERSION,
  HUQAN_PACKAGE_FORMAT_VERSION,
  SUPPORTED_ATP_VERSION,
  SUPPORTED_PROTOCOL_VERSION,
  PACKAGE_COLLECTIONS,
  OBJECT_TYPE_MAP,
  isNonEmptyString,
  getObjectIdField,
  buildEmbeddedObjectMetadata,
  pushError,
  pushWarning,
  requiredString,
};

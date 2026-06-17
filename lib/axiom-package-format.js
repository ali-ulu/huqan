'use strict';

const fs = require('fs');
const {
  ATP_OBJECT_TYPES,
  validateATPObject,
  normalizeATPValidationError,
} = require('./atp-conformance');

const AXIOM_PACKAGE_FORMAT_VERSION = '0.1';
const SUPPORTED_ATP_VERSION = '0.1';
const OBJECT_TYPE_MAP = Object.freeze({
  provenanceRecords: ATP_OBJECT_TYPES.provenanceRecord,
  auditEvents: ATP_OBJECT_TYPES.auditEvent,
  candidateClaims: ATP_OBJECT_TYPES.candidateClaim,
  conflictResults: ATP_OBJECT_TYPES.conflictResult,
  verificationResults: ATP_OBJECT_TYPES.verificationResult,
  trustReceipts: ATP_OBJECT_TYPES.trustReceipt,
  causalChains: ATP_OBJECT_TYPES.causalChain,
  simulationResults: ATP_OBJECT_TYPES.simulationResult,
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function getObjectIdField(collectionName) {
  switch (collectionName) {
    case 'provenanceRecords': return 'provenanceId';
    case 'auditEvents': return 'auditId';
    case 'candidateClaims': return 'candidateId';
    case 'conflictResults': return 'conflictId';
    case 'verificationResults': return 'verificationId';
    case 'trustReceipts': return 'receiptId';
    case 'causalChains': return 'chainId';
    case 'simulationResults': return 'simulationId';
    default: return 'id';
  }
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

function validatePackageManifest(manifest) {
  const warnings = [];
  const errors = [];
  if (!isPlainObject(manifest)) {
    pushError(errors, 'INVALID_PACKAGE_MANIFEST', 'manifest', 'manifest must be an object');
    return { warnings, errors };
  }

  requiredString(errors, manifest, 'packageId', 'INVALID_PACKAGE_MANIFEST');
  requiredString(errors, manifest, 'format', 'INVALID_PACKAGE_MANIFEST');
  requiredString(errors, manifest, 'formatVersion', 'INVALID_PACKAGE_MANIFEST');
  requiredString(errors, manifest, 'createdAt', 'INVALID_PACKAGE_MANIFEST');
  requiredString(errors, manifest, 'createdBy', 'INVALID_PACKAGE_MANIFEST');
  requiredString(errors, manifest, 'workspaceId', 'INVALID_PACKAGE_MANIFEST');
  requiredString(errors, manifest, 'description', 'INVALID_PACKAGE_MANIFEST');
  requiredString(errors, manifest, 'atpVersion', 'INVALID_PACKAGE_MANIFEST');

  if (manifest.format !== 'axiom-package') {
    pushError(errors, 'INVALID_PACKAGE_MANIFEST', 'format', 'format must be axiom-package');
  }
  if (manifest.formatVersion !== AXIOM_PACKAGE_FORMAT_VERSION) {
    pushError(errors, 'INVALID_PACKAGE_MANIFEST', 'formatVersion', `formatVersion must be ${AXIOM_PACKAGE_FORMAT_VERSION}`);
  }
  if (manifest.atpVersion !== SUPPORTED_ATP_VERSION) {
    pushError(errors, 'INVALID_PACKAGE_MANIFEST', 'atpVersion', `atpVersion must be ${SUPPORTED_ATP_VERSION}`);
  }
  if (Number.isNaN(Date.parse(manifest.createdAt))) {
    pushError(errors, 'INVALID_PACKAGE_MANIFEST', 'createdAt', 'createdAt must be a parseable timestamp');
  }

  if (!isPlainObject(manifest.objectCounts)) {
    pushError(errors, 'INVALID_PACKAGE_MANIFEST', 'objectCounts', 'objectCounts must be an object');
  } else {
    for (const [key, type] of Object.entries(OBJECT_TYPE_MAP)) {
      if (typeof manifest.objectCounts[key] !== 'number' || Number.isNaN(manifest.objectCounts[key])) {
        pushError(errors, 'INVALID_PACKAGE_MANIFEST', `objectCounts.${key}`, `${key} count is required`);
      } else if (manifest.objectCounts[key] < 0 || !Number.isInteger(manifest.objectCounts[key])) {
        pushError(errors, 'INVALID_PACKAGE_MANIFEST', `objectCounts.${key}`, `${key} count must be a non-negative integer`);
      }
    }
  }

  if (manifest.source !== undefined && manifest.source !== null && !isPlainObject(manifest.source) && typeof manifest.source !== 'string') {
    pushError(errors, 'INVALID_PACKAGE_MANIFEST', 'source', 'source must be a string or an object');
  }

  return { warnings, errors };
}

function validatePackageIndex(index, objects = null) {
  const warnings = [];
  const errors = [];
  if (!isPlainObject(index)) {
    pushError(errors, 'INVALID_PACKAGE_INDEX', 'index', 'index must be an object');
    return { warnings, errors };
  }

  const objectMetadata = buildEmbeddedObjectMetadata(objects);
  const allowedTypes = new Set(Object.values(OBJECT_TYPE_MAP));

  for (const field of ['byId', 'bySourceRef', 'byWorkspaceId', 'byType']) {
    if (!isPlainObject(index[field])) {
      pushError(errors, 'INVALID_PACKAGE_INDEX', field, `${field} must be an object`);
    }
  }

  const byId = isPlainObject(index.byId) ? index.byId : {};
  for (const [id, ref] of Object.entries(byId)) {
    if (!isPlainObject(ref)) {
      pushError(errors, 'INVALID_PACKAGE_INDEX', `byId.${id}`, 'byId entry must be an object');
      continue;
    }
    if (!isNonEmptyString(ref.type)) {
      pushError(errors, 'INVALID_PACKAGE_INDEX', `byId.${id}.type`, 'byId entry type is required');
    } else if (!allowedTypes.has(ref.type)) {
      pushError(errors, 'INVALID_PACKAGE_INDEX', `byId.${id}.type`, 'byId entry type is not supported');
    }
    if (!isNonEmptyString(ref.workspaceId)) {
      pushError(errors, 'INVALID_PACKAGE_INDEX', `byId.${id}.workspaceId`, 'byId entry workspaceId is required');
    }

    const metadata = objectMetadata.get(id);
    if (metadata) {
      if (metadata.type && ref.type && metadata.type !== ref.type) {
        pushError(errors, 'INVALID_PACKAGE_INDEX', `byId.${id}.type`, `byId entry type must match embedded object type ${metadata.type}`);
      }
      if (metadata.workspaceId && ref.workspaceId && metadata.workspaceId !== ref.workspaceId) {
        pushError(errors, 'INVALID_PACKAGE_INDEX', `byId.${id}.workspaceId`, `byId entry workspaceId must match embedded object workspaceId ${metadata.workspaceId}`);
      }
      if (metadata.sourceRef && isNonEmptyString(ref.sourceRef) && metadata.sourceRef !== ref.sourceRef) {
        pushError(errors, 'INVALID_PACKAGE_INDEX', `byId.${id}.sourceRef`, `byId entry sourceRef must match embedded object sourceRef ${metadata.sourceRef}`);
      }
    }
  }

  const validateIdCollections = (field, collection) => {
    if (!isPlainObject(collection)) return;
    for (const [key, ids] of Object.entries(collection)) {
      if (!Array.isArray(ids)) {
        pushError(errors, 'INVALID_PACKAGE_INDEX', `${field}.${key}`, `${field}.${key} must be an array`);
        continue;
      }
      for (const [index, id] of ids.entries()) {
        if (!isNonEmptyString(id)) {
          pushError(errors, 'INVALID_PACKAGE_INDEX', `${field}.${key}[${index}]`, `${field}.${key}[${index}] must be a non-empty string`);
          continue;
        }
        if (!byId[id]) {
          pushError(errors, 'INVALID_PACKAGE_INDEX', `${field}.${key}[${index}]`, `index entry ${id} is missing from byId`);
          continue;
        }
        if (field === 'byWorkspaceId' && byId[id].workspaceId !== key) {
          pushError(errors, 'INVALID_PACKAGE_INDEX', `${field}.${key}[${index}]`, `index entry ${id} workspaceId must be ${key}`);
        }
        if (field === 'bySourceRef' && objectMetadata.size > 0) {
          const metadata = objectMetadata.get(id);
          if (metadata && metadata.sourceRef && metadata.sourceRef !== key) {
            pushError(errors, 'INVALID_PACKAGE_INDEX', `${field}.${key}[${index}]`, `index entry ${id} sourceRef must be ${metadata.sourceRef}`);
          }
        }
      }
    }
  };

  validateIdCollections('bySourceRef', index.bySourceRef);
  validateIdCollections('byWorkspaceId', index.byWorkspaceId);
  validateIdCollections('byType', index.byType);

  return { warnings, errors };
}

function validateEmbeddedObjects(objects) {
  const warnings = [];
  const errors = [];
  if (!isPlainObject(objects)) {
    pushError(errors, 'INVALID_AXIOM_PACKAGE', 'objects', 'objects must be an object');
    return { warnings, errors, embeddedCounts: {} };
  }

  const embeddedCounts = {};
  for (const collectionName of Object.keys(objects)) {
    if (!Object.prototype.hasOwnProperty.call(OBJECT_TYPE_MAP, collectionName)) {
      pushError(errors, 'INVALID_AXIOM_PACKAGE', `objects.${collectionName}`, 'unknown embedded object collection');
    }
  }

  for (const [collectionName, type] of Object.entries(OBJECT_TYPE_MAP)) {
    const items = objects[collectionName];
    if (!Array.isArray(items)) {
      pushError(errors, 'INVALID_AXIOM_PACKAGE', `objects.${collectionName}`, `${collectionName} must be an array`);
      continue;
    }

    embeddedCounts[collectionName] = items.length;
    items.forEach((item, index) => {
      const validation = validateATPObject(type, item, { packageContext: true, strict: true });
      if (!validation.ok) {
        for (const entry of validation.errors) {
          pushError(errors, 'INVALID_ATP_OBJECT', `objects.${collectionName}[${index}].${entry.field || ''}`.replace(/\.$/, ''), entry.message);
        }
      }
      for (const warning of validation.warnings || []) {
        pushWarning(warnings, `objects.${collectionName}[${index}]`, warning);
      }
    });
  }

  return { warnings, errors, embeddedCounts };
}

function validateObjectCounts(manifestCounts, embeddedCounts) {
  const warnings = [];
  for (const key of Object.keys(OBJECT_TYPE_MAP)) {
    const expected = manifestCounts?.[key];
    const actual = embeddedCounts[key] ?? 0;
    if (typeof expected === 'number' && expected !== actual) {
      pushWarning(warnings, `manifest.objectCounts.${key}`, `expected ${expected} but found ${actual}`);
    }
  }
  return warnings;
}

function validateAxiomPackage(pkg, opts = {}) {
  const warnings = [];
  const errors = [];

  if (!isPlainObject(pkg)) {
    pushError(errors, 'INVALID_AXIOM_PACKAGE', '', 'package must be an object');
    return { ok: false, warnings, errors };
  }

  const manifestResult = validatePackageManifest(pkg.manifest);
  warnings.push(...manifestResult.warnings.map((warning) => ({
    ...warning,
    field: warning.field ? `manifest.${warning.field}` : 'manifest',
  })));
  errors.push(...manifestResult.errors.map((error) => ({
    ...error,
    field: error.field ? `manifest.${error.field}` : 'manifest',
  })));

  const objectsResult = validateEmbeddedObjects(pkg.objects);
  warnings.push(...objectsResult.warnings);
  errors.push(...objectsResult.errors);

  const indexResult = validatePackageIndex(pkg.index, pkg.objects);
  warnings.push(...indexResult.warnings.map((warning) => ({
    ...warning,
    field: warning.field ? `index.${warning.field}` : 'index',
  })));
  errors.push(...indexResult.errors.map((error) => ({
    ...error,
    field: error.field ? `index.${error.field}` : 'index',
  })));

  if (!isPlainObject(pkg.metadata)) {
    pushError(errors, 'INVALID_AXIOM_PACKAGE', 'metadata', 'metadata must be an object');
  } else if (Array.isArray(pkg.metadata.warnings)) {
    for (const warning of pkg.metadata.warnings) {
      if (typeof warning === 'string' && warning.trim()) {
        warnings.push({ field: 'metadata.warnings', message: warning });
      }
    }
  }

  warnings.push(...validateObjectCounts(pkg.manifest?.objectCounts, objectsResult.embeddedCounts));

  const extensionKeys = Object.keys(pkg).filter((key) => key.startsWith('x-'));
  if (opts.allowExtensions === false && extensionKeys.length > 0) {
    for (const key of extensionKeys) {
      pushError(errors, 'INVALID_AXIOM_PACKAGE', key, 'extension fields are not allowed when allowExtensions is false');
    }
  } else {
    for (const key of extensionKeys) {
      pushWarning(warnings, key, 'extension field preserved');
    }
  }

  return {
    ok: errors.length === 0,
    warnings,
    errors,
  };
}

function validateAxiomPackageFile(filePath, opts = {}) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return validateAxiomPackage(parsed, opts);
  } catch (error) {
    return {
      ok: false,
      warnings: [],
      errors: [normalizeATPValidationError(error, 'file')],
    };
  }
}

module.exports = {
  AXIOM_PACKAGE_FORMAT_VERSION,
  validateAxiomPackage,
  validateAxiomPackageFile,
  normalizeAxiomPackageValidationError: normalizeATPValidationError,
};

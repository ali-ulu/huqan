'use strict';

const fs = require('fs');
const {
  ATP_OBJECT_TYPES,
  validateATPObject,
  normalizeATPValidationError,
} = require('./atp-conformance');

const AXIOM_PACKAGE_FORMAT_VERSION = '0.1';
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
  if (manifest.atpVersion !== '0.1') {
    pushError(errors, 'INVALID_PACKAGE_MANIFEST', 'atpVersion', 'atpVersion must be 0.1');
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

function validatePackageIndex(index) {
  const warnings = [];
  const errors = [];
  if (!isPlainObject(index)) {
    pushError(errors, 'INVALID_PACKAGE_INDEX', 'index', 'index must be an object');
    return { warnings, errors };
  }

  for (const field of ['byId', 'bySourceRef', 'byWorkspaceId', 'byType']) {
    if (!isPlainObject(index[field])) {
      pushError(errors, 'INVALID_PACKAGE_INDEX', field, `${field} must be an object`);
    }
  }

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
  for (const [collectionName, type] of Object.entries(OBJECT_TYPE_MAP)) {
    const items = objects[collectionName];
    if (!Array.isArray(items)) {
      pushError(errors, 'INVALID_AXIOM_PACKAGE', `objects.${collectionName}`, `${collectionName} must be an array`);
      continue;
    }

    embeddedCounts[collectionName] = items.length;
    items.forEach((item, index) => {
      const validation = validateATPObject(type, item);
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

  const indexResult = validatePackageIndex(pkg.index);
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

  if (manifestResult.errors.length === 0) {
    warnings.push(...validateObjectCounts(pkg.manifest.objectCounts, objectsResult.embeddedCounts));
  }

  if (opts.allowExtensions !== false) {
    for (const key of Object.keys(pkg)) {
      if (key.startsWith('x-')) continue;
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

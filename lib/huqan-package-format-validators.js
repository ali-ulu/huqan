'use strict';

// Manifest, index and embedded-object validation for
// lib/huqan-package-format.js (#3089). Moved verbatim; shared constants and
// helpers live in lib/huqan-package-format-primitives.js and the entry stays
// the public require target.
const { validateATPObject } = require('./atp-conformance');
const { isPlainObject } = require('./is-plain-object');
const {
  AXIOM_PACKAGE_FORMAT_VERSION,
  HUQAN_PACKAGE_FORMAT_VERSION,
  SUPPORTED_ATP_VERSION,
  SUPPORTED_PROTOCOL_VERSION,
  OBJECT_TYPE_MAP,
  isNonEmptyString,
  buildEmbeddedObjectMetadata,
  pushError,
  pushWarning,
  requiredString,
} = require('./huqan-package-format-primitives');

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
  const legacy = manifest.format === 'axiom-package'
    && manifest.formatVersion === AXIOM_PACKAGE_FORMAT_VERSION;
  const canonical = manifest.format === 'huqan-package'
    && manifest.formatVersion === HUQAN_PACKAGE_FORMAT_VERSION;

  if (!legacy && !canonical) {
    pushError(
      errors,
      'INVALID_PACKAGE_MANIFEST',
      'format',
      'format and formatVersion must identify axiom-package 0.1 or huqan-package 0.2',
    );
  }

  if (legacy) {
    requiredString(errors, manifest, 'atpVersion', 'INVALID_PACKAGE_MANIFEST');
    if (manifest.atpVersion !== SUPPORTED_ATP_VERSION) {
      pushError(errors, 'INVALID_PACKAGE_MANIFEST', 'atpVersion', `atpVersion must be ${SUPPORTED_ATP_VERSION}`);
    }
    if (Object.prototype.hasOwnProperty.call(manifest, 'protocolVersion')) {
      pushError(errors, 'INVALID_PACKAGE_MANIFEST', 'protocolVersion', 'legacy manifests must not include protocolVersion');
    }
  }

  if (canonical) {
    if (!Object.prototype.hasOwnProperty.call(manifest, 'source')) {
      pushError(errors, 'INVALID_PACKAGE_MANIFEST', 'source', 'source is required');
    }
    requiredString(errors, manifest, 'protocolVersion', 'INVALID_PACKAGE_MANIFEST');
    if (manifest.protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
      pushError(errors, 'INVALID_PACKAGE_MANIFEST', 'protocolVersion', `protocolVersion must be ${SUPPORTED_PROTOCOL_VERSION}`);
    }
    if (Object.prototype.hasOwnProperty.call(manifest, 'atpVersion')) {
      pushError(errors, 'INVALID_PACKAGE_MANIFEST', 'atpVersion', 'canonical manifests must not include atpVersion');
    }
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
  const errors = [];
  for (const key of Object.keys(OBJECT_TYPE_MAP)) {
    const expected = manifestCounts?.[key];
    const actual = embeddedCounts[key] ?? 0;
    if (typeof expected === 'number' && expected !== actual) {
      pushError(
        errors,
        'PACKAGE_OBJECT_COUNT_MISMATCH',
        `manifest.objectCounts.${key}`,
        `manifest declares ${expected} but package embeds ${actual}`,
      );
    }
  }
  return errors;
}

module.exports = {
  validatePackageManifest,
  validatePackageIndex,
  validateEmbeddedObjects,
  validateObjectCounts,
};

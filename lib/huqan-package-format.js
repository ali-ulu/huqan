'use strict';

// Public entry for the HUQAN/AXIOM package format (#3089). The shared
// primitives live in lib/huqan-package-format-primitives.js, the manifest,
// index and embedded-object validators in
// lib/huqan-package-format-validators.js. This file stays the require target
// and re-exports the exact same names.
const fs = require('fs');
const { normalizeATPValidationError } = require('./atp-conformance');
const { copyDeterministicJson } = require('./deterministic-json-copy');
const { isPlainObject } = require('./is-plain-object');
const {
  AXIOM_PACKAGE_FORMAT_VERSION,
  HUQAN_PACKAGE_FORMAT_VERSION,
  SUPPORTED_PROTOCOL_VERSION,
  pushError,
  pushWarning,
} = require('./huqan-package-format-primitives');
const {
  validatePackageManifest,
  validatePackageIndex,
  validateEmbeddedObjects,
  validateObjectCounts,
} = require('./huqan-package-format-validators');

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

  errors.push(...validateObjectCounts(pkg.manifest?.objectCounts, objectsResult.embeddedCounts));

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

function validateHuqanPackage(pkg, opts = {}) {
  return validateAxiomPackage(pkg, opts);
}

function validateHuqanPackageFile(filePath, opts = {}) {
  return validateAxiomPackageFile(filePath, opts);
}

function createHuqanPackage(pkg, opts = {}) {
  const snapshot = copyDeterministicJson(pkg);
  if (!isPlainObject(snapshot) || !isPlainObject(snapshot.manifest)) {
    throw new TypeError('package and package.manifest must be objects');
  }

  const manifest = {
    ...snapshot.manifest,
    format: 'huqan-package',
    formatVersion: HUQAN_PACKAGE_FORMAT_VERSION,
    protocolVersion: SUPPORTED_PROTOCOL_VERSION,
  };
  delete manifest.atpVersion;
  const canonicalPackage = { ...snapshot, manifest };
  const validation = validateHuqanPackage(canonicalPackage, opts);
  if (!validation.ok) {
    const error = new Error('canonical HUQAN package is invalid');
    error.code = 'INVALID_HUQAN_PACKAGE';
    error.validation = validation;
    throw error;
  }
  return canonicalPackage;
}

function writeHuqanPackageFile(filePath, pkg, opts = {}) {
  if (typeof filePath !== 'string' || !/\.huqan(?:\.json)?$/i.test(filePath)) {
    throw new TypeError('canonical package file must use .huqan or .huqan.json');
  }
  const canonicalPackage = createHuqanPackage(pkg, opts);
  fs.writeFileSync(filePath, `${JSON.stringify(canonicalPackage, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  return canonicalPackage;
}

module.exports = {
  AXIOM_PACKAGE_FORMAT_VERSION,
  HUQAN_PACKAGE_FORMAT_VERSION,
  SUPPORTED_PROTOCOL_VERSION,
  validateAxiomPackage,
  validateAxiomPackageFile,
  validateHuqanPackage,
  validateHuqanPackageFile,
  createHuqanPackage,
  writeHuqanPackageFile,
  normalizeAxiomPackageValidationError: normalizeATPValidationError,
};

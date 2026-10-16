'use strict';

const {
  ATP_OBJECT_TYPES,
  validateATPObject,
  validateATPFixture,
  normalizeATPValidationError,
} = require('../../lib/atp-conformance');
const {
  validateAxiomPackage,
  validateAxiomPackageFile,
  validateHuqanPackage,
  validateHuqanPackageFile,
  createHuqanPackage,
  writeHuqanPackageFile,
  AXIOM_PACKAGE_FORMAT_VERSION,
  HUQAN_PACKAGE_FORMAT_VERSION,
} = require('../../lib/huqan-package-format');

const SUPPORTED_PROTOCOLS = Object.freeze({
  atp: '0.1',
  avp: '0.1',
  axiomPackageFormat: AXIOM_PACKAGE_FORMAT_VERSION,
  huqanPackageFormat: HUQAN_PACKAGE_FORMAT_VERSION,
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function withStatusFailure(validation, field, message) {
  if (!validation.ok) {
    return validation;
  }

  return {
    ...validation,
    ok: false,
    errors: [
      ...validation.errors,
      {
        code: 'VALIDATION_ERROR',
        field,
        message,
      },
    ],
  };
}

function verifyATPObject(type, object, opts = {}) {
  const validation = validateATPObject(type, object, opts);
  if (type === ATP_OBJECT_TYPES.verificationResult && isPlainObject(object)) {
    if ((object.status === 'unsupported' || object.status === 'contradicted') && object.ok === true) {
      return withStatusFailure(validation, 'status', 'unsupported or contradicted verification results cannot be treated as verified');
    }
  }
  return validation;
}

function verifyTrustReceipt(receipt, opts = {}) {
  return validateATPObject(ATP_OBJECT_TYPES.trustReceipt, receipt, opts);
}

function verifyVerificationResult(result, opts = {}) {
  return verifyATPObject(ATP_OBJECT_TYPES.verificationResult, result, opts);
}

function verifyAxiomPackage(pkg, opts = {}) {
  if (typeof pkg === 'string') {
    return validateAxiomPackageFile(pkg, opts);
  }
  return validateAxiomPackage(pkg, opts);
}

function verifyAxiomPackageFile(filePath, opts = {}) {
  return validateAxiomPackageFile(filePath, opts);
}

function verifyHuqanPackage(pkg, opts = {}) {
  if (typeof pkg === 'string') return validateHuqanPackageFile(pkg, opts);
  return validateHuqanPackage(pkg, opts);
}

function verifyHuqanPackageFile(filePath, opts = {}) {
  return validateHuqanPackageFile(filePath, opts);
}

function getSupportedProtocols() {
  return { ...SUPPORTED_PROTOCOLS };
}

function createVerifier(options = {}) {
  const mergedOptions = { ...options };
  return {
    packageName: 'huqan-verify',
    packageVersion: '0.1.0',
    status: 'skeleton',
    supportedProtocols: getSupportedProtocols(),
    options: mergedOptions,
    ATP_OBJECT_TYPES,
    getSupportedProtocols,
    verifyATPObject: (type, object, validateOptions = {}) => verifyATPObject(type, object, { ...mergedOptions, ...validateOptions }),
    verifyTrustReceipt: (receipt, validateOptions = {}) => verifyTrustReceipt(receipt, { ...mergedOptions, ...validateOptions }),
    verifyVerificationResult: (result, validateOptions = {}) => verifyVerificationResult(result, { ...mergedOptions, ...validateOptions }),
    verifyAxiomPackage: (pkg, validateOptions = {}) => verifyAxiomPackage(pkg, { ...mergedOptions, ...validateOptions }),
    verifyAxiomPackageFile: (filePath, validateOptions = {}) => verifyAxiomPackageFile(filePath, { ...mergedOptions, ...validateOptions }),
    verifyHuqanPackage: (pkg, validateOptions = {}) => verifyHuqanPackage(pkg, { ...mergedOptions, ...validateOptions }),
    verifyHuqanPackageFile: (filePath, validateOptions = {}) => verifyHuqanPackageFile(filePath, { ...mergedOptions, ...validateOptions }),
    createHuqanPackage: (pkg, validateOptions = {}) => createHuqanPackage(pkg, { ...mergedOptions, ...validateOptions }),
    validateATPFixture: (type, filePath, validateOptions = {}) => validateATPFixture(type, filePath, { ...mergedOptions, ...validateOptions }),
    normalizeATPValidationError,
  };
}

module.exports = {
  packageName: 'huqan-verify',
  packageVersion: '0.1.0',
  status: 'skeleton',
  supportedProtocols: getSupportedProtocols(),
  ATP_OBJECT_TYPES,
  getSupportedProtocols,
  verifyATPObject,
  verifyTrustReceipt,
  verifyVerificationResult,
  verifyAxiomPackage,
  verifyAxiomPackageFile,
  verifyHuqanPackage,
  verifyHuqanPackageFile,
  validateATPObject,
  validateATPFixture,
  validateAxiomPackage,
  validateAxiomPackageFile,
  validateHuqanPackage,
  validateHuqanPackageFile,
  createHuqanPackage,
  writeHuqanPackageFile,
  normalizeATPValidationError,
  createVerifier,
};

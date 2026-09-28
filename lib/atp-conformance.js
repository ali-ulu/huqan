'use strict';

const fs = require('fs');

const { normalizeATPValidationError } = require('./atp-conformance-primitives');
const { ATP_OBJECT_TYPES, validateATPObject } = require('./atp-conformance-validators');

function validateATPFixture(type, filePath, opts = {}) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return validateATPObject(type, parsed, opts);
  } catch (error) {
    return {
      ok: false,
      type,
      warnings: [],
      errors: [normalizeATPValidationError(error, 'file')],
    };
  }
}

function runATPConformance(fixtures = [], opts = {}) {
  const items = Array.isArray(fixtures) ? fixtures : [fixtures];
  const results = [];
  const warnings = [];
  const errors = [];

  for (const item of items) {
    const descriptor = typeof item === 'string' ? { filePath: item, type: opts.type } : item || {};
    const filePath = descriptor.filePath || descriptor.path || '';
    const type = descriptor.type || opts.type || '';
    const validation = validateATPFixture(type, filePath, opts);
    const result = {
      filePath,
      ...validation,
    };
    results.push(result);
    warnings.push(...validation.warnings);
    if (!validation.ok) {
      errors.push(...validation.errors.map((entry) => ({
        filePath,
        type,
        ...entry,
      })));
    }
  }

  return {
    ok: errors.length === 0,
    warnings,
    errors,
    results,
  };
}

module.exports = {
  ATP_OBJECT_TYPES,
  validateATPObject,
  validateATPFixture,
  runATPConformance,
  normalizeATPValidationError,
};

'use strict';

const { copyDeterministicJson } = require('../deterministic-json-copy');

function normalizeEvidence(value) {
  if (value === undefined || value === null) return { ok: true, evidence: [] };
  if (!Array.isArray(value)) {
    return { ok: false, error: { code: 'INVALID_EVIDENCE', message: 'evidence must be an array of JSON-safe values' } };
  }
  try {
    return { ok: true, evidence: copyDeterministicJson(value) };
  } catch (error) {
    return {
      ok: false,
      error: { code: 'INVALID_EVIDENCE', message: error?.message || 'evidence must be JSON-safe' },
    };
  }
}

module.exports = { normalizeEvidence };

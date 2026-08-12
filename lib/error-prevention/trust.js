'use strict';

const OBJECTIVE_FAILURE_SOURCES = new Set([
  'test_failure',
  'ci_failure',
  'tool_failure',
  'verifier_failure',
]);

const FAILURE_SOURCES = Object.freeze([
  ...OBJECTIVE_FAILURE_SOURCES,
  'user_correction',
  'model_self_report',
  'external_content',
]);

function normalizeSource(value) {
  const source = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return FAILURE_SOURCES.includes(source) ? source : 'external_content';
}

function classifyFailureTrust(source, evidence = []) {
  const normalized = normalizeSource(source);
  if (OBJECTIVE_FAILURE_SOURCES.has(normalized) && Array.isArray(evidence) && evidence.length > 0) {
    return { source: normalized, verificationStatus: 'verified', trust: 'high' };
  }
  if (normalized === 'user_correction') {
    return { source: normalized, verificationStatus: 'candidate', trust: 'medium' };
  }
  return { source: normalized, verificationStatus: 'unverified', trust: 'low' };
}

module.exports = {
  FAILURE_SOURCES,
  OBJECTIVE_FAILURE_SOURCES,
  classifyFailureTrust,
  normalizeSource,
};

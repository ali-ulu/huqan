'use strict';

const crypto = require('node:crypto');
const { stableStringify } = require('../receipt/canonical-receipt');

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePath(value) {
  return cleanString(value).replace(/\\/g, '/').replace(/\/{2,}/g, '/');
}

function normalizeAction(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    tool: cleanString(source.tool).toLowerCase(),
    operation: cleanString(source.operation || source.action).toLowerCase(),
    workspaceId: cleanString(source.workspaceId) || 'default',
    repo: cleanString(source.repo || source.repository).toLowerCase(),
    path: normalizePath(source.path),
    signature: cleanString(source.signature),
  };
}

function sha256(value) {
  return crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

function buildActionFingerprint(input = {}) {
  return sha256(normalizeAction(input));
}

function buildFailureFingerprint(input = {}) {
  return sha256({
    action: normalizeAction(input),
    expected: cleanString(input.expected),
    observed: cleanString(input.observed),
  });
}

module.exports = {
  buildActionFingerprint,
  buildFailureFingerprint,
  normalizeAction,
};

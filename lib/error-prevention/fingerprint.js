'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { stableStringify } = require('../receipt/canonical-receipt');

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePath(value) {
  const cleaned = cleanString(value).replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (!cleaned) return '';

  // Lexical-only normalization: collapse equivalent repo-relative dot segments
  // without resolving against the filesystem or widening absolute/out-of-scope paths.
  const normalized = path.posix.normalize(cleaned);
  if (normalized === '.' || normalized === './') return '';
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
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

'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { stableStringify } = require('../receipt/canonical-receipt');
const { copyDeterministicJson } = require('../deterministic-json-copy');

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

/**
 * The failure fingerprint binds every field a projected task can be derived
 * from, so two records that would produce different output cannot share an id.
 * A record that carries a payload (#3801) folds it in; one that does not omits
 * the key entirely, which keeps the id of every record written before payloads
 * existed exactly as it was. A payload that is not JSON-safe contributes
 * nothing here for the same reason the record builder drops it: the record will
 * not carry it either.
 */
function fingerprintPayload(value) {
  if (value === undefined || value === null) return undefined;
  try {
    return copyDeterministicJson(value);
  } catch {
    return undefined;
  }
}

function buildFailureFingerprint(input = {}) {
  const payload = fingerprintPayload(input.payload);
  return sha256({
    action: normalizeAction(input),
    expected: cleanString(input.expected),
    observed: cleanString(input.observed),
    ...(payload === undefined ? {} : { payload }),
  });
}

module.exports = {
  buildActionFingerprint,
  buildFailureFingerprint,
  normalizeAction,
};

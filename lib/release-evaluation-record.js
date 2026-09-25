'use strict';

// #2505 implementation order (H independent evaluation, first slice): the
// release evaluation record format. An evaluator distinct from the
// implementation author signs a record binding the release SHA,
// suite/fixture digests, evaluator identity, environment, pass/fail counts,
// critical findings, accepted risk and expiry.
//
// This module owns the SHAPE and its verification, not the ceremony: it does
// not check that the evaluator really is distinct, run any suite, or publish
// anything. A failed or missing record blocks release publication, but that
// gate lives wherever releases publish -- here the record either verifies or
// it does not. The record ID is the hash of the canonical content, so any
// edit after signing breaks the binding instead of silently changing it.

const crypto = require('node:crypto');

const EVALUATION_RECORD_VERSION = 'huqan-release-evaluation-v1';
const HEX64 = /^[0-9a-f]{64}$/i;
const HEX40 = /^[0-9a-f]{40}$/i;
const MAX_TEXT = 512;
const MAX_FINDINGS = 64;

function text(value, field, { max = MAX_TEXT } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${field} exceeds bounded length`);
  return normalized;
}

function count(value, field) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative integer`);
  return value;
}

function sha(value, field) {
  const normalized = text(value, field, { max: 64 }).toLowerCase();
  if (!HEX64.test(normalized) && !HEX40.test(normalized)) {
    throw new TypeError(`${field} must be a hex release SHA`);
  }
  return normalized;
}

function digestMap(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const names = Object.keys(value);
  if (!names.length) throw new TypeError(`${field} must bind at least one digest`);
  const out = {};
  for (const name of names) {
    if (!name.trim() || name.length > 128) throw new TypeError(`${field} names must be bounded`);
    const digest = typeof value[name] === 'string' ? value[name].trim().toLowerCase() : '';
    if (!HEX64.test(digest)) throw new TypeError(`${field}.${name} must be a hex digest`);
    out[name] = digest;
  }
  return Object.freeze(out);
}

function findingsList(value) {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_FINDINGS) {
    throw new TypeError('criticalFindings must be a bounded array');
  }
  return Object.freeze(value.map((entry, index) => text(entry, `criticalFindings[${index}]`)));
}

function canonicalBody(fields) {
  return JSON.stringify({
    version: EVALUATION_RECORD_VERSION,
    releaseSha: fields.releaseSha,
    suiteDigests: fields.suiteDigests,
    evaluator: fields.evaluator,
    environment: fields.environment,
    passCount: fields.passCount,
    failCount: fields.failCount,
    criticalFindings: fields.criticalFindings,
    acceptedRisk: fields.acceptedRisk,
    expiresAt: fields.expiresAt,
  });
}

function recordIdFor(fields) {
  return `release-eval:${crypto.createHash('sha256').update(canonicalBody(fields), 'utf8').digest('hex')}`;
}

/**
 * Build a signed-by-content evaluation record. The evaluator identity is a
 * claimed field: this function binds it, it does not authenticate it.
 */
function buildReleaseEvaluationRecord(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('evaluation input must be an object');
  }
  const fields = {
    releaseSha: sha(input.releaseSha, 'releaseSha'),
    suiteDigests: digestMap(input.suiteDigests, 'suiteDigests'),
    evaluator: text(input.evaluator, 'evaluator'),
    environment: text(input.environment, 'environment'),
    passCount: count(input.passCount, 'passCount'),
    failCount: count(input.failCount, 'failCount'),
    criticalFindings: findingsList(input.criticalFindings),
    acceptedRisk: text(input.acceptedRisk, 'acceptedRisk'),
    expiresAt: text(input.expiresAt, 'expiresAt'),
  };
  if (!Number.isFinite(Date.parse(fields.expiresAt))) {
    throw new TypeError('expiresAt must be a valid instant');
  }
  const recordId = recordIdFor(fields);
  return Object.freeze({ version: EVALUATION_RECORD_VERSION, ...fields, recordId });
}

/**
 * Verify structure, formats, expiry and the content binding. Expired means
 * invalid: an evaluation record is a claim about a release at a time, not
 * forever. `now` is injectable so tests never depend on the clock.
 */
function verifyReleaseEvaluationRecord(record, { now = null } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return Object.freeze({ valid: false, reason: 'record_malformed' });
  }
  try {
    const rebuilt = buildReleaseEvaluationRecord(record);
    if (rebuilt.recordId !== record.recordId) {
      return Object.freeze({ valid: false, reason: 'binding_mismatch' });
    }
  } catch (error) {
    return Object.freeze({ valid: false, reason: 'record_malformed', detail: String(error?.message || error) });
  }
  const at = now === undefined || now === null ? Date.now() : Date.parse(now);
  if (!Number.isFinite(at)) return Object.freeze({ valid: false, reason: 'invalid_now' });
  if (Date.parse(record.expiresAt) <= at) {
    return Object.freeze({ valid: false, reason: 'record_expired' });
  }
  if (record.failCount > 0) {
    return Object.freeze({ valid: true, failed: true, reason: 'recorded_failures_present' });
  }
  return Object.freeze({ valid: true, failed: false, reason: null });
}

module.exports = {
  EVALUATION_RECORD_VERSION,
  buildReleaseEvaluationRecord,
  verifyReleaseEvaluationRecord,
};

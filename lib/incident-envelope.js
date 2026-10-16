'use strict';

// #2505 implementation order (K incident exchange, first slice): the
// versioned private incident envelope. It carries who, what, when and what
// proof -- never the sensitive source content itself, which stays out of
// general telemetry by construction (there is no field for it).
//
// Format only: sending is a separate, human-approved act and no automatic
// transmission is implied. Cross-border exchange is a separate signed,
// minimized projection and is explicitly out of this slice. Biological
// misuse classification triggers restricted handling downstream; this module
// only records the class, it does not route anything.

const crypto = require('node:crypto');

const INCIDENT_ENVELOPE_VERSION = 'huqan-incident-envelope-v1';
const INCIDENT_CLASSES = Object.freeze(['cyber', 'biological', 'other']);
const MAX_TEXT = 512;

function text(value, field, { max = MAX_TEXT } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${field} exceeds bounded length`);
  return normalized;
}

function maybeText(value, field, options) {
  if (value === undefined || value === null) return null;
  return text(value, field, options);
}

function instant(value, field) {
  const normalized = text(value, field);
  const millis = Date.parse(normalized);
  if (!Number.isFinite(millis)) throw new TypeError(`${field} must be a valid instant`);
  return new Date(millis).toISOString();
}

function canonicalBody(fields) {
  return JSON.stringify({
    version: INCIDENT_ENVELOPE_VERSION,
    incidentLabel: fields.incidentLabel,
    eventTimes: fields.eventTimes,
    reporterAuthority: fields.reporterAuthority,
    recipientAuthority: fields.recipientAuthority,
    class: fields.class,
    severity: fields.severity,
    affectedScope: fields.affectedScope,
    evidenceHash: fields.evidenceHash,
    containmentStatus: fields.containmentStatus,
    contactChannel: fields.contactChannel,
    disclosureBasis: fields.disclosureBasis,
    correctionOf: fields.correctionOf,
  });
}

/**
 * Build a versioned incident envelope. Identity and content decisions stay
 * with the sender: authority fields are claims, and there is nowhere to put
 * source content even if a caller wanted to.
 */
function buildIncidentEnvelope(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('incident input must be an object');
  }
  const times = input.eventTimes && typeof input.eventTimes === 'object' && !Array.isArray(input.eventTimes)
    ? input.eventTimes
    : {};
  const fields = {
    // Records round-trip through here on verify: prefer the stored label so
    // the computed id never feeds its own hash.
    incidentLabel: text(input.incidentLabel !== undefined ? input.incidentLabel : input.incidentId, 'incidentId', { max: 128 }),
    eventTimes: Object.freeze({
      occurredAt: times.occurredAt === undefined || times.occurredAt === null
        ? null
        : instant(times.occurredAt, 'eventTimes.occurredAt'),
      detectedAt: instant(times.detectedAt, 'eventTimes.detectedAt'),
    }),
    reporterAuthority: text(input.reporterAuthority, 'reporterAuthority'),
    recipientAuthority: text(input.recipientAuthority, 'recipientAuthority'),
    class: text(input.class, 'class', { max: 32 }),
    severity: text(input.severity, 'severity', { max: 64 }),
    affectedScope: text(input.affectedScope, 'affectedScope'),
    evidenceHash: text(input.evidenceHash, 'evidenceHash', { max: 128 }),
    containmentStatus: text(input.containmentStatus, 'containmentStatus'),
    contactChannel: text(input.contactChannel, 'contactChannel'),
    disclosureBasis: text(input.disclosureBasis, 'disclosureBasis'),
    correctionOf: maybeText(input.correctionOf, 'correctionOf', { max: 128 }),
  };
  if (!INCIDENT_CLASSES.includes(fields.class)) {
    throw new TypeError(`class must be one of ${INCIDENT_CLASSES.join(', ')}`);
  }
  const incidentId = `incident:${crypto.createHash('sha256').update(canonicalBody(fields), 'utf8').digest('hex')}`;
  return Object.freeze({ version: INCIDENT_ENVELOPE_VERSION, ...fields, incidentId });
}

/**
 * Verify shape, formats and the content binding. Expired nothing: envelopes
 * do not expire, corrections supersede through correctionOf.
 */
function verifyIncidentEnvelope(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return Object.freeze({ valid: false, reason: 'envelope_malformed' });
  }
  try {
    const rebuilt = buildIncidentEnvelope(record);
    if (rebuilt.incidentId !== record.incidentId) {
      return Object.freeze({ valid: false, reason: 'binding_mismatch' });
    }
  } catch (error) {
    return Object.freeze({ valid: false, reason: 'envelope_malformed', detail: String(error?.message || error) });
  }
  return Object.freeze({ valid: true, reason: null });
}

module.exports = {
  INCIDENT_ENVELOPE_VERSION,
  INCIDENT_CLASSES,
  buildIncidentEnvelope,
  verifyIncidentEnvelope,
};

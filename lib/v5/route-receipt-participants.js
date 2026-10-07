'use strict';

/**
 * Participant binding and handoff validation for the V5 route receipt (#3479).
 *
 * The reader (`lib/v5/runtime-reader.js`) and the writer
 * (`lib/v5/runtime-writer-sections.js`) must enforce the same binding, or one
 * side can accept a package the other rejects. Keeping the rules in one module
 * is what makes that impossible rather than merely unlikely.
 *
 * A handoff may only name endpoints the package declares as participants,
 * mirroring the bounded A2A exchange's source/target binding
 * (`lib/a2a/bounded-exchange.js`). An unknown or injected target fails closed
 * instead of being accepted as free text.
 */

const { isPlainObject } = require('../is-plain-object');
const { isNonEmptyString } = require('./runtime-writer-guards');

const HANDOFF_KEYS = new Set(['from', 'to', 'reason']);
const MAX_PARTICIPANTS = 16;

function validateParticipants(participants) {
  if (participants === undefined) {
    return null;
  }

  if (
    !Array.isArray(participants) ||
    participants.length < 2 ||
    participants.length > MAX_PARTICIPANTS ||
    !participants.every(isNonEmptyString) ||
    new Set(participants).size !== participants.length
  ) {
    return 'malformed_route_receipt_metadata';
  }

  return null;
}

function validateHandoff(handoff, participants) {
  if (!isPlainObject(handoff)) {
    return 'malformed_route_receipt_metadata';
  }

  if (Object.keys(handoff).some((key) => !HANDOFF_KEYS.has(key))) {
    return 'malformed_route_receipt_metadata';
  }

  if (
    !isNonEmptyString(handoff.from) ||
    !isNonEmptyString(handoff.to) ||
    handoff.from === handoff.to
  ) {
    return 'malformed_route_receipt_metadata';
  }

  if (handoff.reason !== undefined && !isNonEmptyString(handoff.reason)) {
    return 'malformed_route_receipt_metadata';
  }

  if (
    !Array.isArray(participants) ||
    !participants.includes(handoff.from) ||
    !participants.includes(handoff.to)
  ) {
    return 'malformed_route_receipt_metadata';
  }

  return null;
}

module.exports = Object.freeze({
  HANDOFF_KEYS,
  MAX_PARTICIPANTS,
  validateHandoff,
  validateParticipants,
});

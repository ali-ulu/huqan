'use strict';

// #2206: the writer's schema version and verdict statuses, the JSON safety
// walk, the BLOCK result and the disallowed-claim check.

const { isPlainObject } = require('../is-plain-object');

const SUPPORTED_SCHEMA_VERSION = 'v5.shared_trust_package.writer_input.v1';

const ALLOWED_VERDICT_STATUSES = new Set([
  'allow',
  'review',
  'dry_run_only',
  'block'
]);


function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function cloneJson(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

/**
 * #1298: cloneJson() above throws a raw TypeError on anything
 * JSON.stringify cannot serialize, and nothing upstream of buildPackage()
 * rejected that -- writeRuntimePackage's fail-closed writer boundary could
 * leak an uncaught exception instead of a structured BLOCK result.
 *
 * Unlike structural-signing-helper.js's findJsonSafetyError (which this is
 * modeled on but deliberately narrower), this only flags what
 * JSON.stringify actually *throws* on: a BigInt anywhere in the value, or a
 * circular reference. undefined/function/symbol/non-finite-number values
 * are not throw hazards -- JSON.stringify silently drops or nulls them
 * (`JSON.stringify({a: undefined})` is `'{}'`, not an error) -- and
 * writer input legitimately carries explicit `undefined` on omitted
 * optional fields (see e.g. `input.routeReceipt !== undefined` below), so
 * rejecting those here would fail closed on valid input.
 */
function findJsonSafetyError(value, ancestors = new Set()) {
  if (typeof value === 'bigint') {
    return 'invalid_json_value';
  }
  if (value === null || typeof value !== 'object') {
    return null;
  }
  if (ancestors.has(value)) {
    return 'invalid_json_value';
  }

  ancestors.add(value);
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    const error = findJsonSafetyError(nested, ancestors);
    if (error) {
      ancestors.delete(value);
      return error;
    }
  }
  ancestors.delete(value);
  return null;
}

function block(reasonCategory) {
  return {
    ok: false,
    verdict: 'BLOCK',
    reason_category: reasonCategory
  };
}

function hasDisallowedClaim(input) {
  const claims = isPlainObject(input.claims) ? input.claims : {};

  if (claims.signed === true || claims.signatureRuntime) {
    return 'unsigned_but_claimed_signed';
  }

  if (
    claims.runtimeReaderImplemented === true ||
    claims.readerImplemented === true ||
    claims.exportImplemented === true ||
    claims.runtimeExportImplemented === true
  ) {
    return 'runtime_reader_claim';
  }

  if (claims.verificationRuntime === true || claims.verificationRuntimeImplemented === true) {
    return 'verification_runtime_claim';
  }

  if (claims.a2aTransport === true || claims.a2aTransportEnabled === true) {
    return 'a2a_transport_claim';
  }

  if (claims.connectorEnforcement === true || claims.connectorEnforcementImplemented === true) {
    return 'connector_enforcement_claim';
  }

  if (claims.marketplaceReady === true || claims.marketplaceImplemented === true) {
    return 'marketplace_claim';
  }

  if (claims.agentActionPolicyEngine === true || claims.agentActionPolicyEngineEnabled === true) {
    return 'agentaction_policy_engine_claim';
  }

  return null;
}

module.exports = {
  ALLOWED_VERDICT_STATUSES,
  SUPPORTED_SCHEMA_VERSION,
  block,
  cloneJson,
  findJsonSafetyError,
  hasDisallowedClaim,
  isNonEmptyString,
};

/**
 * Bounded V5 preflight routes.
 *
 * These are authenticated, read-only inspection surfaces. They do not persist,
 * sign, authorize, execute, or promote trust. The fixture/conformance/readiness
 * chain remains a release/CI surface rather than a request-time executor.
 */

const { writeApiError, writeJson } = require('../server-response-helpers');
const { readRuntimePackage } = require('../v5/runtime-reader');
const { prepareStructuralSigning } = require('../v5/structural-signing-helper');

const PREFLIGHT_PREFIX = '/api/v5/preflight';
const READER_PATH = `${PREFLIGHT_PREFIX}/reader`;
const STRUCTURAL_SIGNING_PATH = `${PREFLIGHT_PREFIX}/structural-signing`;
const MAX_ERROR_ITEMS = 8;
const READER_NON_CLAIMS = Object.freeze([
  'readable_does_not_prove_trust',
  'readable_does_not_prove_authorization',
  'readable_does_not_prove_verification',
  'preflight_is_read_only',
]);
const STRUCTURAL_NON_CLAIMS = Object.freeze([
  'structural_only_is_not_cryptographic_signing',
  'placeholder_signature_is_not_trust_evidence',
  'preflight_is_read_only',
]);

function boundedErrors(result) {
  return Array.isArray(result?.errors) ? result.errors.slice(0, MAX_ERROR_ITEMS) : [];
}

function writeResult(req, res, result, nonClaims) {
  if (!result || result.ok !== true) {
    writeJson(req, res, 400, {
      ok: false,
      status: result?.status || 'blocked',
      reasonCategory: result?.reason_category || result?.reasonCategory || 'preflight_rejected',
      errors: boundedErrors(result),
      applied: false,
    });
    return;
  }

  writeJson(req, res, 200, {
    ok: true,
    ...result,
    nonClaims: [...nonClaims],
    applied: false,
  }, { 'Cache-Control': 'no-store' });
}

function createV5PreflightRoute({ parseJsonRequest } = {}) {
  if (typeof parseJsonRequest !== 'function') {
    throw new TypeError('v5 preflight route requires parseJsonRequest');
  }

  async function handle(req, res, reqUrl) {
    if (![READER_PATH, STRUCTURAL_SIGNING_PATH].includes(reqUrl.pathname)) return false;

    if (req.method !== 'POST') {
      writeApiError(req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return true;
    }

    let body;
    try {
      body = await parseJsonRequest(req, res, { maxBytes: 65_536 });
    } catch (_) {
      return true;
    }
    if (body === undefined || body === null) return true;

    if (reqUrl.pathname === READER_PATH) {
      writeResult(req, res, readRuntimePackage(body), READER_NON_CLAIMS);
      return true;
    }

    writeResult(req, res, prepareStructuralSigning(body), STRUCTURAL_NON_CLAIMS);
    return true;
  }

  return handle;
}

module.exports = {
  PREFLIGHT_PREFIX,
  READER_PATH,
  STRUCTURAL_SIGNING_PATH,
  createV5PreflightRoute,
};

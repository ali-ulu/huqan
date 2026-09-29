'use strict';

function normalizeStatus(statusCode) {
  const status = Number(statusCode);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 500;
}

function classifyHttpError(statusCode) {
  const status = normalizeStatus(statusCode);
  if (status === 400 || status === 422) return Object.freeze({ errorClass: 'input', operatorAction: 'correct_request' });
  if (status === 401) return Object.freeze({ errorClass: 'authentication', operatorAction: 'authenticate_and_retry' });
  if (status === 403) return Object.freeze({ errorClass: 'authorization', operatorAction: 'obtain_authorization' });
  if (status === 404) return Object.freeze({ errorClass: 'routing', operatorAction: 'verify_route_or_resource' });
  if (status === 405) return Object.freeze({ errorClass: 'method', operatorAction: 'use_supported_method' });
  if (status === 409) return Object.freeze({ errorClass: 'state_conflict', operatorAction: 'reconcile_state' });
  if (status === 413) return Object.freeze({ errorClass: 'request_limit', operatorAction: 'reduce_request_size' });
  if (status === 429) return Object.freeze({ errorClass: 'rate_limit', operatorAction: 'backoff_and_retry' });
  if (status === 502 || status === 503 || status === 504) {
    return Object.freeze({ errorClass: 'availability', operatorAction: 'restore_dependency_or_retry' });
  }
  if (status >= 500) return Object.freeze({ errorClass: 'internal', operatorAction: 'inspect_logs_and_retry' });
  return Object.freeze({ errorClass: 'request', operatorAction: 'inspect_error_code' });
}

function normalizeCode(code) {
  const normalized = String(code || 'HTTP_ERROR').trim();
  return normalized || 'HTTP_ERROR';
}

function buildStructuredErrorPayload(statusCode, code, message, details = {}) {
  const taxonomy = classifyHttpError(statusCode);
  return {
    ok: false,
    error: {
      code: normalizeCode(code),
      message: String(message || ''),
      class: taxonomy.errorClass,
      operatorAction: taxonomy.operatorAction,
      details: details && typeof details === 'object' && !Array.isArray(details) ? details : {},
    },
  };
}

function buildLegacyErrorPayload(statusCode, code, message) {
  const taxonomy = classifyHttpError(statusCode);
  return {
    error: String(message || ''),
    errorCode: normalizeCode(code),
    errorClass: taxonomy.errorClass,
    operatorAction: taxonomy.operatorAction,
  };
}

module.exports = Object.freeze({
  buildLegacyErrorPayload,
  buildStructuredErrorPayload,
  classifyHttpError,
});

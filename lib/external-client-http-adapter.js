'use strict';
const { EXTERNAL_CLIENT_ENDPOINT_METHOD } = require('./external-client-endpoint-contract');
const { DEFAULT_MAX_UPLOAD_BODY } = require('../requestGuards');
const EXTERNAL_CLIENT_HTTP_ADAPTER_VERSION = 'external-client-http-adapter-0-v1';
const EXTERNAL_CLIENT_HTTP_MAX_BODY_BYTES = DEFAULT_MAX_UPLOAD_BODY;
const EXTERNAL_CLIENT_HTTP_READ_TIMEOUT_MS = 5000;
const MAX_DEPTH = 32; const MAX_VALUES = 10000; const MAX_ID_LENGTH = 256;
const REQUEST_STATUS = Symbol('external-client-http-adapter-request-status');
const STATUS_CODES = Object.freeze({
  403: Object.freeze([
    'EXTERNAL_CLIENT_WORKSPACE_MISMATCH', 'EXTERNAL_CLIENT_PACKAGE_ID_MISMATCH',
    'EXTERNAL_CLIENT_PACKAGE_WORKSPACE_MISMATCH', 'EXTERNAL_CLIENT_PACKAGE_IDENTITY_MISMATCH', 'EXTERNAL_CLIENT_SIGNATURE_REQUIRED',
    'EXTERNAL_CLIENT_SIGNATURE_ALGORITHM_UNSUPPORTED', 'EXTERNAL_CLIENT_TRUSTED_KEY_REQUIRED', 'EXTERNAL_CLIENT_TRUSTED_KEY_SCOPE_MISMATCH', 'EXTERNAL_CLIENT_SIGNATURE_INVALID',
    'EXTERNAL_CLIENT_AUTHORITY_IDENTITY_MISMATCH', 'EXTERNAL_CLIENT_AUTHORITY_PERMISSION_REQUIRED', 'EXTERNAL_CLIENT_AUTHORITY_KEY_INVALID', 'EXTERNAL_CLIENT_AUTHORITY_KEY_REVOKED',
    'EXTERNAL_CLIENT_AUTHORITY_CREATED_AT_INVALID', 'EXTERNAL_CLIENT_AUTHORITY_STALE',
    'EXTERNAL_CLIENT_AUTHORITY_FUTURE_DATED', 'EXTERNAL_CLIENT_MUTATION_AUTHORITY_MISMATCH',
  ]),
  409: Object.freeze(['EXTERNAL_CLIENT_AUTHORITY_REPLAY_DETECTED', 'EXTERNAL_CLIENT_MUTATION_LOCAL_CANDIDATE_COLLISION']),
  422: Object.freeze(['EXTERNAL_CLIENT_PACKAGE_INVALID', 'EXTERNAL_CLIENT_MUTATION_INPUT_INVALID', 'EXTERNAL_CLIENT_MUTATION_CANDIDATE_INVALID']),
  503: Object.freeze([
    'EXTERNAL_CLIENT_IDENTITY_REQUIRED', 'EXTERNAL_CLIENT_WORKSPACE_REQUIRED',
    'EXTERNAL_CLIENT_AUTHORITATIVE_WORKSPACE_REQUIRED', 'EXTERNAL_CLIENT_EXPECTED_PACKAGE_REQUIRED',
    'EXTERNAL_CLIENT_AUTHORITY_REQUIRED', 'EXTERNAL_CLIENT_AUTHORITY_CLOCK_INVALID',
    'EXTERNAL_CLIENT_AUTHORITY_REPLAY_OWNER_REQUIRED', 'EXTERNAL_CLIENT_AUTHORITY_REPLAY_RESERVATION_FAILED',
    'EXTERNAL_CLIENT_PACKAGE_HANDLER_REQUIRED',
    'EXTERNAL_CLIENT_MUTATION_GRAPH_REQUIRED', 'EXTERNAL_CLIENT_MUTATION_OUTCOME_UNKNOWN',
  ]),
});
function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try { return [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
  catch (_) { return false; }
}
function exactDataKeys(value, expected) {
  if (!plain(value)) return false;
  try {
    const keys = Reflect.ownKeys(value);
    const sortedExpected = [...expected].sort();
    if (keys.length !== expected.length || keys.some((key) => typeof key !== 'string')) return false;
    if (![...keys].sort().every((key, index) => key === sortedExpected[index])) return false;
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable && Object.hasOwn(descriptor, 'value');
    });
  } catch (_) { return false; }
}
function dependency(options) {
  if (!exactDataKeys(options, ['admitPackage'])) {
    throw new TypeError('exact admitPackage dependency is required');
  }
  const admitPackage = Object.getOwnPropertyDescriptor(options, 'admitPackage').value;
  if (typeof admitPackage !== 'function') throw new TypeError('admitPackage must be a function');
  return admitPackage;
}
function response(statusCode, body, allow = false) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }; if (statusCode === 408) headers.Connection = 'close';
  if (allow) headers.Allow = EXTERNAL_CLIENT_ENDPOINT_METHOD;
  return Object.freeze({ statusCode, headers: Object.freeze(headers), body: Object.freeze(body) });
}
function reject(statusCode, allow = false) { return response(statusCode, { ok: false }, allow); }
function failRequest(statusCode) {
  const error = new Error('external client HTTP request rejected');
  Object.defineProperty(error, REQUEST_STATUS, { value: statusCode });
  throw error;
}
function requestStatus(error) {
  try { return Object.getOwnPropertyDescriptor(error, REQUEST_STATUS)?.value || null; }
  catch (_) { return null; }
}
function header(request, name) {
  try {
    const headers = request?.headers;
    const raw = request?.rawHeaders;
    if (headers !== undefined && (!headers || typeof headers !== 'object' || Array.isArray(headers))) {
      return { ok: false };
    }
    const values = [];
    for (const key of headers === undefined ? [] : Reflect.ownKeys(headers)) {
      if (typeof key !== 'string' || key.toLowerCase() !== name) continue;
      const entry = Object.getOwnPropertyDescriptor(headers, key);
      if (!entry?.enumerable || !Object.hasOwn(entry, 'value')) return { ok: false };
      values.push(entry.value);
    }
    if (values.length > 1) return { ok: false };
    if (raw !== undefined) {
      if (!Array.isArray(raw) || raw.length % 2 !== 0) return { ok: false };
      let count = 0;
      let rawValue;
      for (let index = 0; index < raw.length; index += 2) {
        if (typeof raw[index] === 'string' && raw[index].toLowerCase() === name) {
          count += 1;
          rawValue = raw[index + 1];
        }
      }
      if (count > 1 || (count === 1 && values.length === 1 && rawValue !== values[0])) return { ok: false };
      if (values.length === 0 && count === 1) values.push(rawValue);
    }
    return { ok: true, present: values.length === 1, value: values[0] };
  } catch (_) { return { ok: false }; }
}
function validContentType(value) {
  return typeof value === 'string' && /^application\/json(?:\s*;\s*charset\s*=\s*utf-8\s*)?$/i.test(value.trim());
}
function declaredLength(value) {
  if (value === undefined) return { ok: true, present: false, value: 0 };
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0
      ? { ok: true, present: true, value } : { ok: false };
  }
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value.trim())) return { ok: false };
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed)
    ? { ok: true, present: true, value: parsed } : { ok: false };
}
function detach(request, event, listener) {
  try {
    const remove = typeof request.off === 'function' ? request.off : request.removeListener;
    if (typeof remove === 'function') remove.call(request, event, listener);
  } catch (_) {}
}
function stop(request, drain = false) {
  try {
    if (drain && typeof request.resume === 'function') request.resume();
    else if (typeof request.destroy === 'function') request.destroy();
    else if (typeof request.pause === 'function') request.pause();
  } catch (_) {}
}
function readBody(request) {
  if (!request || typeof request !== 'object' || typeof request.on !== 'function') {
    return Promise.resolve({ ok: false, statusCode: 400 });
  }
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let done = false;
    let timer;
    const listeners = [];
    const cleanup = () => {
      clearTimeout(timer);
      for (const [event, listener] of listeners) detach(request, event, listener);
    };
    const finish = (result, shouldStop = false, shouldDrain = false) => {
      if (done) return;
      done = true;
      cleanup();
      if (shouldStop) stop(request, shouldDrain);
      resolve(result);
    };
    const onData = (chunk) => {
      let copy;
      try {
        if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) copy = Buffer.from(chunk);
        else if (typeof chunk === 'string') copy = Buffer.from(chunk, 'utf8');
        else return finish({ ok: false, statusCode: 400 }, true);
      } catch (_) { return finish({ ok: false, statusCode: 400 }, true); }
      if (bytes + copy.length > EXTERNAL_CLIENT_HTTP_MAX_BODY_BYTES) {
        return finish({ ok: false, statusCode: 413 }, true, true);
      }
      bytes += copy.length;
      if (copy.length) chunks.push(copy);
    };
    const onEnd = () => {
      try { finish({ ok: true, body: Buffer.concat(chunks, bytes) }); }
      catch (_) { finish({ ok: false, statusCode: 400 }); }
    };
    const onBad = () => finish({ ok: false, statusCode: 400 }, true);
    listeners.push(
      ['data', onData], ['end', onEnd], ['error', onBad],
      ['aborted', onBad], ['close', onBad],
    );
    try {
      for (const [event, listener] of listeners) request.on(event, listener);
      timer = setTimeout(
        // Drain without retaining bytes so the caller can write 408 before close (#719).
        () => finish({ ok: false, statusCode: 408 }, true, true),
        EXTERNAL_CLIENT_HTTP_READ_TIMEOUT_MS,
      );
    } catch (_) { finish({ ok: false, statusCode: 400 }, true); }
  });
}
function primitive(value) {
  return value === null || ['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value));
}
function define(target, key, value) {
  Object.defineProperty(target, key, {
    value, enumerable: true, writable: true, configurable: true,
  });
}
function snapshot(value) {
  if (!exactDataKeys(value, ['package', 'signature'])
    || !exactDataKeys(value.signature, ['algorithm', 'keyId', 'value'])) failRequest(400);
  const root = {};
  const stack = [{ source: value, target: root, depth: 0 }];
  const containers = [root];
  let visited = 1;
  while (stack.length) {
    const frame = stack.pop();
    const keys = Array.isArray(frame.source)
      ? Array.from({ length: frame.source.length }, (_, index) => String(index))
      : Object.keys(frame.source);
    for (const key of keys) {
      if (key === '__proto__' || !Object.hasOwn(frame.source, key)) failRequest(400);
      const entry = Object.getOwnPropertyDescriptor(frame.source, key);
      if (!entry?.enumerable || !Object.hasOwn(entry, 'value') || ++visited > MAX_VALUES) failRequest(400);
      if (primitive(entry.value)) { define(frame.target, key, entry.value); continue; }
      if (!entry.value || typeof entry.value !== 'object'
        || (!Array.isArray(entry.value) && !plain(entry.value))) failRequest(400);
      if (frame.depth + 1 > MAX_DEPTH) failRequest(400);
      const child = Array.isArray(entry.value) ? new Array(entry.value.length) : {};
      define(frame.target, key, child);
      containers.push(child);
      stack.push({ source: entry.value, target: child, depth: frame.depth + 1 });
    }
  }
  for (let index = containers.length - 1; index >= 0; index -= 1) Object.freeze(containers[index]);
  return root;
}
function field(value, key) {
  try {
    const entry = Object.getOwnPropertyDescriptor(value, key);
    return entry?.enumerable && Object.hasOwn(entry, 'value')
      ? { ok: true, value: entry.value } : { ok: false };
  } catch (_) { return { ok: false }; }
}
function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH && value === value.trim();
}
function admissionResult(result) {
  try {
    if (!exactDataKeys(result, ['ok', 'gate', 'authority', 'admission'])
      || !Object.isFrozen(result)) return null;
    const ok = field(result, 'ok');
    const gate = field(result, 'gate');
    const authority = field(result, 'authority');
    const admission = field(result, 'admission');
    if (ok.value !== true || !plain(gate.value) || !Object.isFrozen(gate.value)
      || !plain(authority.value) || !Object.isFrozen(authority.value)
      || !plain(admission.value) || !Object.isFrozen(admission.value)) return null;
    const values = {};
    for (const key of ['ok', 'outcome', 'replayed', 'operationId', 'localCandidateId', 'receiptId']) {
      const entry = field(admission.value, key);
      if (!entry.ok) return null;
      values[key] = entry.value;
    }
    if (values.ok !== true || values.outcome !== 'pending_review'
      || typeof values.replayed !== 'boolean' || !validId(values.operationId)
      || !validId(values.localCandidateId) || !validId(values.receiptId)) return null;
    return Object.freeze({
      replayed: values.replayed, operationId: values.operationId,
      localCandidateId: values.localCandidateId, receiptId: values.receiptId,
    });
  } catch (_) { return null; }
}
function dependencyStatus(error) {
  try {
    const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
    for (const [status, codes] of Object.entries(STATUS_CODES)) {
      if (codes.includes(code)) return Number(status);
    }
  } catch (_) {}
  return 503;
}
function createExternalClientHttpAdapter(options) {
  const admitPackage = dependency(options);
  const handle = async (request) => {
    try {
      let method;
      try { method = request?.method; } catch (_) { return reject(500); }
      if (method !== EXTERNAL_CLIENT_ENDPOINT_METHOD) return reject(405, true);
      const type = header(request, 'content-type');
      if (!type.ok || !type.present || !validContentType(type.value)) return reject(415);
      const declared = header(request, 'content-length');
      if (!declared.ok) return reject(400);
      const length = declaredLength(declared.present ? declared.value : undefined);
      if (!length.ok) return reject(400);
      if (length.present && length.value > EXTERNAL_CLIENT_HTTP_MAX_BODY_BYTES) return reject(413);
      const read = await readBody(request);
      if (!read.ok) return reject(read.statusCode);
      if (read.body.length === 0) return reject(400);
      let parsed;
      try {
        const text = new globalThis.TextDecoder('utf-8', { fatal: true }).decode(read.body);
        if (!text) return reject(400);
        parsed = JSON.parse(text);
      } catch (_) { return reject(400); }
      const input = snapshot(parsed);
      let result;
      try { result = await admitPackage(input); }
      catch (error) { return reject(dependencyStatus(error)); }
      const admission = admissionResult(result);
      if (!admission) return reject(503);
      return response(admission.replayed ? 200 : 201, {
        ok: true, outcome: 'pending_review', replayed: admission.replayed,
        operationId: admission.operationId, localCandidateId: admission.localCandidateId,
        receiptId: admission.receiptId,
      });
    } catch (error) { return reject(requestStatus(error) || 500); }
  };
  return Object.freeze({ handle }); }
module.exports = Object.freeze({ EXTERNAL_CLIENT_HTTP_ADAPTER_VERSION, EXTERNAL_CLIENT_HTTP_MAX_BODY_BYTES, EXTERNAL_CLIENT_HTTP_READ_TIMEOUT_MS, createExternalClientHttpAdapter });

const DEFAULT_TIMEOUT_MS = 150;
const DEFAULT_MAX_SOURCE_BYTES = 64 * 1024;
const DEFAULT_MAX_INPUT_BYTES = 256 * 1024;
const DEFAULT_MAX_RESULT_BYTES = 256 * 1024;
const DEFAULT_MAX_RESULT_DEPTH = 32;
const DEFAULT_CHILD_HEAP_MB = 32;
const CHILD_PROTOCOL_MAX_BYTES = 512 * 1024;
const CHILD_STARTUP_GRACE_MS = 1000;
const MAX_ERROR_MESSAGE_BYTES = 2048;
const CHILD_MODE = '--huqan-sandbox-child';
const FORBIDDEN_PATTERNS = [
  /\brequire\s*\(/i,
  /\bprocess\b/i,
  /\bglobalThis\b/i,
  /\bglobal\b/i,
  /\bmodule\b/i,
  /\bexports\b/i,
  /\bFunction\b/i,
  /\beval\s*\(/i,
  /\bimport\s*\(/i,
  /\bconstructor\b/i,
  /\bchild_process\b/i,
  /\bfs\b/i,
];

function byteLength(value) {
  return Buffer.byteLength(String(value), 'utf8');
}

function makeLimitError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function cloneValue(value) {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.parse(JSON.stringify(value));
}

function boundedErrorMessage(error) {
  const raw = error && error.message ? String(error.message) : 'Sandbox execution failed.';
  if (byteLength(raw) <= MAX_ERROR_MESSAGE_BYTES) return raw;
  let out = '';
  for (const char of raw) {
    if (byteLength(out + char) > MAX_ERROR_MESSAGE_BYTES - 3) break;
    out += char;
  }
  return out + '...';
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_SOURCE_BYTES,
  DEFAULT_MAX_INPUT_BYTES,
  DEFAULT_MAX_RESULT_BYTES,
  DEFAULT_MAX_RESULT_DEPTH,
  DEFAULT_CHILD_HEAP_MB,
  CHILD_PROTOCOL_MAX_BYTES,
  CHILD_STARTUP_GRACE_MS,
  MAX_ERROR_MESSAGE_BYTES,
  CHILD_MODE,
  FORBIDDEN_PATTERNS,
  byteLength,
  makeLimitError,
  cloneValue,
  boundedErrorMessage,
};

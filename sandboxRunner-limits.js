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

// The child runs only this repository's own code, and the sandboxed realm
// cannot reach `process` at all (`process` is a forbidden token and the vm is
// built with no host object to walk to it). So the child needs none of the
// operator's environment -- and handing it over wholesale also hands over every
// credential the deployment exported, plus knobs like NODE_OPTIONS that change
// how the interpreter starts. Default-deny, with the path variables a bare
// `node <script>` needs on Windows and the coverage instrumentation path.
const SANDBOX_CHILD_ENV_ALLOWLIST = Object.freeze([
  'SystemRoot',
  'SystemDrive',
  'windir',
  'TEMP',
  'TMP',
  'TMPDIR',
  // Instrumentation path, not a credential. c8 attributes the child's own
  // coverage through it, so dropping it hides sandboxRunner-child.js and
  // sandboxRunner-context.js from the coverage floors. The child runs only this
  // repository's code, so the path is the only thing it learns.
  'NODE_V8_COVERAGE',
]);

function buildSandboxChildEnvironment(environment = process.env) {
  const env = {};
  // A Windows environment block is case-insensitive: `SYSTEMROOT` and
  // `SystemRoot` name the same variable. `process.env` hides that behind a
  // proxy, but a plain object handed in by a caller does not, so the allowlist
  // is matched case-insensitively here.
  const entries = Object.entries(environment || {});
  for (const key of SANDBOX_CHILD_ENV_ALLOWLIST) {
    const wanted = key.toLowerCase();
    // Skip a match whose value is unusable, so an empty `tmpdir` cannot shadow a
    // valid `TMPDIR` later in the block (POSIX keeps both spellings distinct).
    const found = entries.find(([name, value]) => name.toLowerCase() === wanted
      && typeof value === 'string' && value);
    if (found) env[key] = found[1];
  }
  return env;
}

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
  SANDBOX_CHILD_ENV_ALLOWLIST,
  buildSandboxChildEnvironment,
  byteLength,
  makeLimitError,
  cloneValue,
  boundedErrorMessage,
};

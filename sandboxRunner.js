const childProcess = require('node:child_process');
const vm = require('node:vm');

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

function appendJsonChunk(state, chunk) {
  const bytes = byteLength(chunk);
  if (state.bytes + bytes > state.maxBytes) {
    throw makeLimitError(state.limitCode, state.limitMessage);
  }
  state.bytes += bytes;
  state.parts.push(chunk);
}

function encodeJsonValue(value, state, depth, inArray = false) {
  if (depth > state.maxDepth) {
    throw makeLimitError(state.depthCode, state.depthMessage);
  }
  if (value === null) {
    appendJsonChunk(state, 'null');
    return true;
  }

  switch (typeof value) {
    case 'string':
      appendJsonChunk(state, JSON.stringify(value));
      return true;
    case 'number':
      appendJsonChunk(state, Number.isFinite(value) ? String(value) : 'null');
      return true;
    case 'boolean':
      appendJsonChunk(state, value ? 'true' : 'false');
      return true;
    case 'undefined':
    case 'function':
    case 'symbol':
      if (inArray) appendJsonChunk(state, 'null');
      return inArray;
    case 'bigint':
      throw new TypeError('Do not know how to serialize a BigInt');
    case 'object':
      break;
    default:
      return false;
  }

  if (state.seen.has(value)) {
    throw new TypeError('Converting circular structure to JSON');
  }
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      appendJsonChunk(state, '[');
      for (let i = 0; i < value.length; i += 1) {
        if (i > 0) appendJsonChunk(state, ',');
        encodeJsonValue(value[i], state, depth + 1, true);
      }
      appendJsonChunk(state, ']');
      return true;
    }

    appendJsonChunk(state, '{');
    let wrote = false;
    for (const key of Object.keys(value)) {
      const item = value[key];
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
      if (wrote) appendJsonChunk(state, ',');
      appendJsonChunk(state, JSON.stringify(key));
      appendJsonChunk(state, ':');
      encodeJsonValue(item, state, depth + 1, false);
      wrote = true;
    }
    appendJsonChunk(state, '}');
    return true;
  } finally {
    state.seen.delete(value);
  }
}

function stringifyBounded(value, opts) {
  const state = {
    parts: [],
    bytes: 0,
    maxBytes: opts.maxBytes,
    maxDepth: opts.maxDepth,
    seen: new Set(),
    limitCode: opts.limitCode,
    limitMessage: opts.limitMessage,
    depthCode: opts.depthCode || opts.limitCode,
    depthMessage: opts.depthMessage || opts.limitMessage,
  };
  encodeJsonValue(value, state, 0, false);
  return state.parts.join('');
}

function cloneValue(value) {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.parse(JSON.stringify(value));
}

function validateSandboxSource(source) {
  const text = String(source || '');
  const violations = [];
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(text)) violations.push(pattern.source);
  }
  return {
    ok: violations.length === 0,
    violations,
  };
}

/**
 * Bootstrap evaluated inside the sandbox realm (#750).
 *
 * Everything the sandbox can reach has to be constructed *by this script*, in
 * the sandbox's own realm. A host-realm object handed in directly carries its
 * realm with it: `console.log.constructor` was the host Function constructor,
 * which `codeGeneration: { strings: false }` does not restrict, so
 * `console.log['con'+'structor']('return pro'+'cess')()` returned the host
 * process object — past the textual denylist, which only rejects the
 * contiguous word. `input` and `context` were the same primitive by way of
 * `x.constructor.constructor`.
 *
 * The bindings arrive as JSON strings; JSON.parse here produces objects whose
 * prototypes belong to this realm, so the same expression now reaches the
 * context's own Function and is blocked by codeGeneration.
 */
const SANDBOX_BOOTSTRAP = `
  globalThis.console = Object.freeze({ log() {}, error() {}, warn() {} });
  globalThis.input = globalThis.__inputJson === undefined
    ? undefined
    : JSON.parse(globalThis.__inputJson);
  globalThis.context = JSON.parse(globalThis.__contextJson);
  delete globalThis.__inputJson;
  delete globalThis.__contextJson;
`;

function jsonBinding(value) {
  const cloned = cloneValue(value);
  if (cloned === undefined) return undefined;
  return JSON.stringify(cloned);
}

function createSandboxContext(bindings = {}) {
  const sandbox = Object.create(null);
  // Strings, not objects: a primitive carries no host prototype into the
  // sandbox, so these are safe to set before the bootstrap consumes them.
  sandbox.__inputJson = jsonBinding(bindings.input);
  sandbox.__contextJson = JSON.stringify(cloneValue(bindings.context || {}));
  // Keep external-memory constructors out of the untrusted realm. Ordinary
  // arrays/objects/strings are constrained by the child V8 heap limit.
  sandbox.ArrayBuffer = undefined;
  sandbox.SharedArrayBuffer = undefined;
  sandbox.Int8Array = undefined;
  sandbox.Uint8Array = undefined;
  sandbox.Uint8ClampedArray = undefined;
  sandbox.Int16Array = undefined;
  sandbox.Uint16Array = undefined;
  sandbox.Int32Array = undefined;
  sandbox.Uint32Array = undefined;
  sandbox.Float32Array = undefined;
  sandbox.Float64Array = undefined;
  sandbox.BigInt64Array = undefined;
  sandbox.BigUint64Array = undefined;
  sandbox.DataView = undefined;
  sandbox.WebAssembly = undefined;
  const context = vm.createContext(sandbox, {
    codeGeneration: {
      strings: false,
      wasm: false,
    },
  });
  // Compiled by us, not by the sandbox, so codeGeneration does not apply.
  new vm.Script(SANDBOX_BOOTSTRAP, { filename: 'sandbox.bootstrap.js' }).runInContext(context);
  return context;
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

function childResult(payload) {
  const timeoutMs = Number(payload.timeoutMs) > 0 ? Number(payload.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const validation = validateSandboxSource(payload.source);
  if (!validation.ok) {
    return {
      ok: false,
      data: null,
      error: {
        code: 'SANDBOX_REJECTED',
        message: 'Sandbox source contains blocked capabilities.',
        details: validation.violations,
      },
      meta: { runner: 'node:vm', timeoutMs, isolation: 'child_process', heapLimitMb: DEFAULT_CHILD_HEAP_MB },
    };
  }

  try {
    const bindings = JSON.parse(payload.bindingsJson || '{}');
    const context = createSandboxContext(bindings);
    const script = new vm.Script(String(payload.source || ''), {
      filename: payload.filename || 'sandbox.vm.js',
    });
    const result = script.runInContext(context, {
      timeout: timeoutMs,
      displayErrors: true,
    });
    const resultJson = stringifyBounded(result === undefined ? null : result, {
      maxBytes: payload.maxResultBytes,
      maxDepth: payload.maxResultDepth,
      limitCode: 'SANDBOX_OUTPUT_LIMIT',
      limitMessage: 'Sandbox result exceeds the configured output byte limit.',
      depthCode: 'SANDBOX_OUTPUT_DEPTH',
      depthMessage: 'Sandbox result exceeds the configured output depth limit.',
    });
    return {
      ok: true,
      dataJson: resultJson,
      error: null,
      meta: { runner: 'node:vm', timeoutMs, isolation: 'child_process', heapLimitMb: DEFAULT_CHILD_HEAP_MB },
    };
  } catch (error) {
    return {
      ok: false,
      data: null,
      error: {
        code: error && error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
          ? 'SANDBOX_TIMEOUT'
          : (error && String(error.code || '').startsWith('SANDBOX_') ? error.code : 'SANDBOX_RUNTIME'),
        message: boundedErrorMessage(error),
      },
      meta: { runner: 'node:vm', timeoutMs, isolation: 'child_process', heapLimitMb: DEFAULT_CHILD_HEAP_MB },
    };
  }
}

function runChildProcess() {
  let request;
  try {
    const input = require('node:fs').readFileSync(0, 'utf8');
    request = JSON.parse(input);
    const response = childResult(request);
    process.stdout.write(JSON.stringify(response));
  } catch (error) {
    process.stdout.write(JSON.stringify({
      ok: false,
      data: null,
      error: { code: 'SANDBOX_RUNTIME', message: boundedErrorMessage(error) },
      meta: { runner: 'node:vm', isolation: 'child_process', heapLimitMb: DEFAULT_CHILD_HEAP_MB },
    }));
  }
}

function runSandboxed(source, bindings = {}, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const sourceText = String(source || '');
  if (byteLength(sourceText) > DEFAULT_MAX_SOURCE_BYTES) {
    return {
      ok: false,
      data: null,
      error: { code: 'SANDBOX_SOURCE_LIMIT', message: 'Sandbox source exceeds the configured byte limit.' },
      meta: { runner: 'node:vm', timeoutMs, isolation: 'child_process', heapLimitMb: DEFAULT_CHILD_HEAP_MB },
    };
  }

  const validation = validateSandboxSource(sourceText);
  if (!validation.ok) {
    return {
      ok: false,
      data: null,
      error: {
        code: 'SANDBOX_REJECTED',
        message: 'Sandbox source contains blocked capabilities.',
        details: validation.violations,
      },
      meta: { runner: 'node:vm', timeoutMs, isolation: 'child_process', heapLimitMb: DEFAULT_CHILD_HEAP_MB },
    };
  }

  let requestJson;
  try {
    const bindingsJson = stringifyBounded(bindings, {
      maxBytes: DEFAULT_MAX_INPUT_BYTES,
      maxDepth: DEFAULT_MAX_RESULT_DEPTH,
      limitCode: 'SANDBOX_INPUT_LIMIT',
      limitMessage: 'Sandbox bindings exceed the configured input byte limit.',
      depthCode: 'SANDBOX_INPUT_DEPTH',
      depthMessage: 'Sandbox bindings exceed the configured input depth limit.',
    });
    requestJson = JSON.stringify({
      source: sourceText,
      bindingsJson,
      timeoutMs,
      filename: byteLength(opts.filename || '') <= 1024 ? (opts.filename || 'sandbox.vm.js') : 'sandbox.vm.js',
      maxResultBytes: DEFAULT_MAX_RESULT_BYTES,
      maxResultDepth: DEFAULT_MAX_RESULT_DEPTH,
    });
  } catch (error) {
    return {
      ok: false,
      data: null,
      error: {
        code: error && String(error.code || '').startsWith('SANDBOX_') ? error.code : 'SANDBOX_RUNTIME',
        message: boundedErrorMessage(error),
      },
      meta: { runner: 'node:vm', timeoutMs, isolation: 'child_process', heapLimitMb: DEFAULT_CHILD_HEAP_MB },
    };
  }

  const environment = { ...process.env };
  delete environment.NODE_OPTIONS;
  const child = childProcess.spawnSync(process.execPath, [
    `--max-old-space-size=${DEFAULT_CHILD_HEAP_MB}`,
    __filename,
    CHILD_MODE,
  ], {
    input: requestJson,
    encoding: 'utf8',
    env: environment,
    timeout: timeoutMs + CHILD_STARTUP_GRACE_MS,
    maxBuffer: CHILD_PROTOCOL_MAX_BYTES,
    windowsHide: true,
  });

  const meta = { runner: 'node:vm', timeoutMs, isolation: 'child_process', heapLimitMb: DEFAULT_CHILD_HEAP_MB };
  if (child.error) {
    return {
      ok: false,
      data: null,
      error: {
        code: child.error.code === 'ETIMEDOUT' ? 'SANDBOX_TIMEOUT' : 'SANDBOX_RESOURCE_LIMIT',
        message: child.error.code === 'ETIMEDOUT'
          ? 'Sandbox execution exceeded its process timeout.'
          : 'Sandbox process exceeded a resource boundary.',
      },
      meta,
    };
  }
  if (child.status !== 0) {
    return {
      ok: false,
      data: null,
      error: { code: 'SANDBOX_RESOURCE_LIMIT', message: 'Sandbox process terminated at the resource boundary.' },
      meta,
    };
  }

  try {
    const response = JSON.parse(child.stdout || '');
    if (response.ok === true && typeof response.dataJson === 'string') {
      return { ok: true, data: JSON.parse(response.dataJson), error: null, meta: response.meta || meta };
    }
    return response;
  } catch (_) {
    return {
      ok: false,
      data: null,
      error: { code: 'SANDBOX_RESOURCE_LIMIT', message: 'Sandbox process returned an invalid bounded response.' },
      meta,
    };
  }
}

if (require.main === module && process.argv[2] === CHILD_MODE) {
  runChildProcess();
} else {
  module.exports = {
    DEFAULT_TIMEOUT_MS,
    DEFAULT_MAX_SOURCE_BYTES,
    DEFAULT_MAX_INPUT_BYTES,
    DEFAULT_MAX_RESULT_BYTES,
    DEFAULT_MAX_RESULT_DEPTH,
    DEFAULT_CHILD_HEAP_MB,
    runSandboxed,
    validateSandboxSource,
  };
}

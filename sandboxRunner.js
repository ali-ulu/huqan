const childProcess = require('node:child_process');

const { evaluateSandboxIsolation } = require('./lib/sandbox-isolation');
const {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_SOURCE_BYTES,
  DEFAULT_MAX_INPUT_BYTES,
  DEFAULT_MAX_RESULT_BYTES,
  DEFAULT_MAX_RESULT_DEPTH,
  DEFAULT_CHILD_HEAP_MB,
  CHILD_PROTOCOL_MAX_BYTES,
  CHILD_STARTUP_GRACE_MS,
  CHILD_MODE,
  byteLength,
  makeLimitError,
  boundedErrorMessage,
} = require('./sandboxRunner-limits');
const { validateSandboxSource } = require('./sandboxRunner-context');
const { runChildProcess } = require('./sandboxRunner-child');

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

  switch (typeof value) { // closed by the language: typeof has a fixed result set, so this stays a switch (#2179)
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

/**
 * AB6 admission, evaluated before anything is spawned.
 *
 * This module is the wall -- a child process, a forbidden-pattern filter, byte
 * and heap and time limits. What it had no notion of is whether a given request
 * should be admitted at all: how far the source is trusted, whether the runner
 * is one the policy recognises, whether the requested timeout is inside the
 * operator's ceiling. AB6 answers exactly that, and until now it answered it
 * for nobody -- the gate was imported once by the MCP adapter and never called
 * (#1253), so the decision layer existed and no execution ever passed through
 * it.
 *
 * The order matters: policy decision, then sandbox creation, then execution.
 * Evaluating after the spawn would make the gate a reporter rather than a gate.
 *
 * `block` refuses. `quarantine` proceeds, which is not a loophole: quarantine
 * means "execution may proceed in an isolated sandbox only", and this is that
 * sandbox. A caller that does not declare `sourceTrust` gets `unknown`, hence
 * quarantine rather than allow -- unproven trust is recorded, not assumed.
 */
function admitSandboxRequest(sourceText, timeoutMs, opts) {
  const verdict = evaluateSandboxIsolation(
    {
      source: sourceText,
      sourceTrust: opts.sourceTrust || 'unknown',
      runner: 'node:vm',
      operation: opts.operation || 'execute',
      timeoutMs,
      workspaceId: opts.workspaceId,
    },
    opts.isolationPolicy ? { policy: opts.isolationPolicy } : {},
  );
  return verdict;
}

function runSandboxed(source, bindings = {}, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const sourceText = String(source || '');

  const isolation = admitSandboxRequest(sourceText, timeoutMs, opts);
  if (isolation.decision === 'block') {
    return {
      ok: false,
      data: null,
      error: {
        code: 'SANDBOX_POLICY_BLOCKED',
        message: 'Sandbox isolation policy refused this request.',
        details: isolation.findings,
      },
      meta: {
        runner: 'node:vm',
        timeoutMs,
        isolation: 'child_process',
        heapLimitMb: DEFAULT_CHILD_HEAP_MB,
        ab6: { decision: isolation.decision, reason: isolation.reason },
      },
    };
  }

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
  // The verdict travels with the result, so a receipt records that the gate ran
  // and what it decided -- not merely that execution happened.
  const meta = {
    runner: 'node:vm',
    timeoutMs,
    isolation: 'child_process',
    heapLimitMb: DEFAULT_CHILD_HEAP_MB,
    ab6: { decision: isolation.decision, reason: isolation.reason },
  };
  let child;
  try {
    child = childProcess.spawnSync(process.execPath, [
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
  } catch (error) {
    // #1310: spawnSync throws synchronously (rather than setting
    // child.error) when the child's stdout/stderr exceeds maxBuffer
    // (ERR_CHILD_PROCESS_STDIO_MAXBUFFER). Map that the same way
    // child.error is mapped below instead of letting it escape and break
    // runSandboxed's "always returns a structured result" contract.
    return {
      ok: false,
      data: null,
      error: {
        code: error && error.code === 'ETIMEDOUT' ? 'SANDBOX_TIMEOUT' : 'SANDBOX_RESOURCE_LIMIT',
        message: error && error.code === 'ETIMEDOUT'
          ? 'Sandbox execution exceeded its process timeout.'
          : 'Sandbox process exceeded a resource boundary.',
      },
      meta,
    };
  }
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
    // The child reports its own meta, which is the authority on what actually
    // ran. The admission verdict is not the child's to report, so it is stamped
    // over the top either way -- otherwise the one path that matters most, a
    // successful execution, would carry no record that a gate had decided it.
    if (response.ok === true) {
      return {
        ok: true,
        data: response.data,
        error: null,
        meta: { ...(response.meta || meta), ab6: meta.ab6 },
      };
    }
    return { ...response, meta: { ...(response.meta || meta), ab6: meta.ab6 } };
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
  runChildProcess(stringifyBounded);
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

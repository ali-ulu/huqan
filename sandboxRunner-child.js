const vm = require('node:vm');

const {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_CHILD_HEAP_MB,
  boundedErrorMessage,
} = require('./sandboxRunner-limits');
const { validateSandboxSource, createSandboxContext } = require('./sandboxRunner-context');

// stringifyBounded is handed in by the entry module: the bounded-JSON codec
// stays beside the entry's dispatch (its typeof switch is the file's recorded
// OCP signal), so requiring it here would point this module's edge back at
// the entry and close a require cycle.
function childResult(payload, stringifyBounded) {
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

// #1310: childResult()'s ok:true result already carries dataJson as a
// bounded, pre-serialized JSON string. Wrapping the whole response in a
// second JSON.stringify() re-escapes every '"' and '\' inside that string,
// which can nearly double its size -- close enough to CHILD_PROTOCOL_MAX_BYTES
// (2x DEFAULT_MAX_RESULT_BYTES) that a quote-heavy result can overflow the
// spawnSync maxBuffer and throw a synchronous, uncaught
// ERR_CHILD_PROCESS_STDIO_MAXBUFFER in the parent. Splice dataJson in as a
// raw JSON value (it is always well-formed JSON, or childResult would not
// have produced it) instead of re-serializing it as a string.
function writeChildResponse(response) {
  if (response.ok === true && typeof response.dataJson === 'string') {
    const metaJson = JSON.stringify(response.meta || null);
    process.stdout.write(`{"ok":true,"data":${response.dataJson},"error":null,"meta":${metaJson}}`);
    return;
  }
  process.stdout.write(JSON.stringify(response));
}

function runChildProcess(stringifyBounded) {
  let request;
  try {
    const input = require('node:fs').readFileSync(0, 'utf8');
    request = JSON.parse(input);
    writeChildResponse(childResult(request, stringifyBounded));
  } catch (error) {
    writeChildResponse({
      ok: false,
      data: null,
      error: { code: 'SANDBOX_RUNTIME', message: boundedErrorMessage(error) },
      meta: { runner: 'node:vm', isolation: 'child_process', heapLimitMb: DEFAULT_CHILD_HEAP_MB },
    });
  }
}

module.exports = {
  childResult,
  writeChildResponse,
  runChildProcess,
};

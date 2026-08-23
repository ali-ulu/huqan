const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  DEFAULT_MAX_SOURCE_BYTES,
  DEFAULT_MAX_INPUT_BYTES,
  runSandboxed,
  validateSandboxSource,
} = require('./sandboxRunner');

describe('Sandbox Runner', () => {
  it('executes simple code with cloned input', () => {
    const result = runSandboxed('({ total: input.a + input.b, safe: true })', {
      input: { a: 2, b: 3 },
    });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.data, { total: 5, safe: true });
    assert.strictEqual(result.meta.runner, 'node:vm');
    assert.strictEqual(result.meta.isolation, 'child_process');
  });

  it('rejects blocked capabilities before execution', () => {
    const validation = validateSandboxSource('require("fs").readFileSync("x")');
    assert.strictEqual(validation.ok, false);
    const result = runSandboxed('require("fs").readFileSync("x")');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'SANDBOX_REJECTED');
  });

  it('times out infinite loops', () => {
    const result = runSandboxed('while (true) {}', {}, { timeoutMs: 25 });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'SANDBOX_TIMEOUT');
  });

  it('rejects oversized source before creating a child', () => {
    const result = runSandboxed('0'.repeat(DEFAULT_MAX_SOURCE_BYTES + 1));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'SANDBOX_SOURCE_LIMIT');
  });

  it('rejects oversized bindings before creating a child', () => {
    const result = runSandboxed('input.value', {
      input: { value: 'x'.repeat(DEFAULT_MAX_INPUT_BYTES + 1) },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'SANDBOX_INPUT_LIMIT');
  });

  it('rejects deeply nested bindings before creating a child', () => {
    let nested = 0;
    for (let i = 0; i < 40; i += 1) nested = [nested];
    const result = runSandboxed('input', { input: nested });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'SANDBOX_INPUT_DEPTH');
  });

  it('removes direct external-memory allocation primitives from the child realm', () => {
    const result = runSandboxed('({ arrayBuffer: typeof ArrayBuffer, typedArray: typeof Uint8Array, dataView: typeof DataView, wasm: typeof WebAssembly })');
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.data, {
      arrayBuffer: 'undefined',
      typedArray: 'undefined',
      dataView: 'undefined',
      wasm: 'undefined',
    });
  });

  it('bounds oversized string results', () => {
    const result = runSandboxed('"x".repeat(400000)');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'SANDBOX_OUTPUT_LIMIT');
  });

  it('bounds oversized array results without destabilizing the caller', () => {
    const result = runSandboxed('new Array(400000).fill("x")');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'SANDBOX_OUTPUT_LIMIT');
    const followup = runSandboxed('1 + 1');
    assert.strictEqual(followup.ok, true);
    assert.strictEqual(followup.data, 2);
  });

  it('bounds deeply nested results', () => {
    const result = runSandboxed('Array.from({ length: 40 }).reduce((v) => [v], 0)');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'SANDBOX_OUTPUT_DEPTH');
  });

  it('does not overflow the child protocol buffer on a quote-heavy result near the size limit (#1310)', () => {
    // A string of this many literal '"' characters JSON-encodes (via
    // stringifyBounded) to just under DEFAULT_MAX_RESULT_BYTES -- passing
    // the result-size bound -- but every byte of that encoding is itself a
    // '"' or '\' character. Wrapping the child's response in a second
    // JSON.stringify() (the pre-fix behavior) re-escapes each of those,
    // pushing the envelope past CHILD_PROTOCOL_MAX_BYTES and either
    // throwing a synchronous ERR_CHILD_PROCESS_STDIO_MAXBUFFER or
    // truncating stdout. The fix avoids the second escaping pass entirely.
    const quoteCount = 131070;
    const result = runSandboxed(`'"'.repeat(${quoteCount})`);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data, '"'.repeat(quoteCount));
  });

  it('contains heap exhaustion in the child process', () => {
    const result = runSandboxed('new Array(20000000).fill({ x: "1234567890" })', {}, { timeoutMs: 2000 });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'SANDBOX_RESOURCE_LIMIT');
    const followup = runSandboxed('({ alive: true })');
    assert.strictEqual(followup.ok, true);
    assert.deepStrictEqual(followup.data, { alive: true });
  });
});

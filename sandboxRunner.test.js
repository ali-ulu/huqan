const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const {
  DEFAULT_MAX_SOURCE_BYTES,
  DEFAULT_MAX_INPUT_BYTES,
  runSandboxed,
  validateSandboxSource,
} = require('./sandboxRunner');
const { buildSandboxChildEnvironment } = require('./sandboxRunner-limits');

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
    // Heap exhaustion must win over the wall-clock deadline even on a loaded
    // Windows runner. Authorize a bounded 10s for this resource-limit test;
    // the production default and the separate timeout assertions stay intact.
    const result = runSandboxed('new Array(20000000).fill({ x: "1234567890" })', {}, {
      timeoutMs: 10_000,
      isolationPolicy: { maximumTimeoutMs: 10_000 },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'SANDBOX_RESOURCE_LIMIT');
    const followup = runSandboxed('({ alive: true })');
    assert.strictEqual(followup.ok, true);
    assert.deepStrictEqual(followup.data, { alive: true });
  });
});

describe('Sandbox child environment', () => {
  it('forwards only the OS path variables, never the operator environment', () => {
    const env = buildSandboxChildEnvironment({
      SystemRoot: 'C:\\Windows',
      TEMP: '/tmp',
      PATH: '/usr/local/bin',
      GITHUB_TOKEN: 'ghp_example',
      AWS_SECRET_ACCESS_KEY: 'example',
      NODE_OPTIONS: '--require ./evil.js',
      NODE_V8_COVERAGE: '/tmp/coverage',
    });
    assert.deepStrictEqual(env, {
      SystemRoot: 'C:\\Windows',
      TEMP: '/tmp',
      NODE_V8_COVERAGE: '/tmp/coverage',
    });
  });

  it('does not hand the child a credential the parent exported', () => {
    const key = 'HUQAN_SANDBOX_TEST_SECRET';
    const previous = process.env[key];
    process.env[key] = 'must-not-reach-the-child';
    try {
      const child = spawnSync(process.execPath, ['-e', `process.stdout.write(String(process.env.${key}))`], {
        env: buildSandboxChildEnvironment(),
        encoding: 'utf8',
      });
      assert.strictEqual(child.stdout, 'undefined');
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  it('still executes with the reduced environment', () => {
    const result = runSandboxed('({ envReduced: true })');
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.data, { envReduced: true });
  });

  it('matches allowlisted keys case-insensitively, as a Windows environment block does', () => {
    const env = buildSandboxChildEnvironment({
      SYSTEMROOT: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      PATH: '/usr/local/bin',
    });
    assert.deepStrictEqual(env, { SystemRoot: 'C:\\Windows', windir: 'C:\\Windows' });
  });

  it('does not let an empty case variant shadow a valid one', () => {
    const env = buildSandboxChildEnvironment({ tmpdir: '', TMPDIR: '/sandbox/tmp' });
    assert.deepStrictEqual(env, { TMPDIR: '/sandbox/tmp' });
  });
});

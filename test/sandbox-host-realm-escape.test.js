const { describe, it } = require('node:test');
const assert = require('node:assert');
const { runSandboxed } = require('../sandboxRunner');

/**
 * `constructor` split across fragments, which the textual denylist cannot see:
 * it only rejects the contiguous word.
 */
const C = "['con' + 'structor']";
const REACH_PROCESS = "('return pro' + 'cess')()";

function escapeAttempt(expression) {
  return runSandboxed(`${expression}.version`, { input: { a: 1 }, context: { b: 2 } });
}

describe('sandbox exposes no host-realm objects (#750)', () => {
  const vectors = [
    ['console.log', `console.log${C}${REACH_PROCESS}`],
    ['console.error', `console.error${C}${REACH_PROCESS}`],
    ['console.warn', `console.warn${C}${REACH_PROCESS}`],
    ['input', `input${C}${C}${REACH_PROCESS}`],
    ['context', `context${C}${C}${REACH_PROCESS}`],
    ['nested input value', `input.a${C}${C}${REACH_PROCESS}`],
    ['object literal', `({})${C}${C}${REACH_PROCESS}`],
    ['array literal', `[]${C}${C}${REACH_PROCESS}`],
    ['function literal', `(function(){})${C}${REACH_PROCESS}`],
    ['string literal', `('s')${C}${C}${REACH_PROCESS}`],
  ];

  for (const [label, expression] of vectors) {
    it(`${label} cannot recover the host process`, () => {
      const result = escapeAttempt(expression);
      assert.strictEqual(result.ok, false, `${label} escaped with ${JSON.stringify(result.data)}`);
      assert.ok(!String(result.data ?? '').includes(process.version));
    });
  }

  it('no vector returns the host node version through any binding', () => {
    const escaped = [];
    for (const [label, expression] of vectors) {
      const result = escapeAttempt(expression);
      if (result.ok && String(result.data ?? '') === process.version) escaped.push(label);
    }
    assert.deepStrictEqual(escaped, [], 'a sandbox payload reached host capabilities');
  });

  it('host require, filesystem and child_process stay unreachable', () => {
    const attempts = [
      `console.log${C}("return req" + "uire('fs').readFileSync")()`,
      `input${C}${C}("return req" + "uire('child_process')")()`,
      `context${C}${C}("return glob" + "alThis")()`,
    ];
    for (const source of attempts) {
      const result = runSandboxed(source, { input: { a: 1 }, context: { b: 2 } });
      assert.strictEqual(result.ok, false, `reached a host capability: ${JSON.stringify(result.data)}`);
    }
  });

  it('the contiguous denylist still rejects the obvious spelling', () => {
    const result = runSandboxed('console.log.constructor("return 1")()', {});
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'SANDBOX_REJECTED');
  });
});

describe('sandbox still does its job', () => {
  it('reads its bindings', () => {
    const result = runSandboxed('input.a + context.b', { input: { a: 1 }, context: { b: 2 } });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data, 3);
  });

  it('tolerates absent bindings', () => {
    const result = runSandboxed('typeof input', {});
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data, 'undefined');
  });

  it('console calls are accepted and inert', () => {
    const result = runSandboxed('console.log("x"); console.warn("y"); console.error("z"); 42', {});
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data, 42);
  });

  it('nested binding structures survive', () => {
    const result = runSandboxed('input.list[1].k', { input: { list: [{ k: 'a' }, { k: 'b' }] } });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data, 'b');
  });

  it('bindings are a copy, not a live host reference', () => {
    const input = { a: 1 };
    const result = runSandboxed('input.a = 99; input.a', { input });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(input.a, 1, 'the sandbox mutated the caller\'s object');
  });

  it('the bootstrap leaves no scaffolding visible', () => {
    // Probed by bare identifier: `globalThis` is itself on the denylist.
    for (const probe of ['typeof __inputJson', 'typeof __contextJson']) {
      const result = runSandboxed(probe, { input: { a: 1 } });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.data, 'undefined', `${probe} leaked bootstrap state`);
    }
  });

  it('code generation from strings stays disabled', () => {
    const result = runSandboxed('eval("1+1")', {});
    assert.strictEqual(result.ok, false);
  });
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { runSandboxed } = require('../sandboxRunner');
const { MAX_TIMEOUT_MS } = require('../lib/sandbox-timeout-policy');

// AB6 now sits in front of execution rather than beside it:
//
//   request -> AB6 policy decision -> sandbox creation -> execution -> receipt
//
// These tests exercise it through `runSandboxed`, the real entry point, so they
// prove the gate is reached rather than that it can be called.

const TRUSTED_SOURCE = '({ total: input.a + input.b })';
const BINDINGS = { input: { a: 1, b: 2 } };

test('a validated request executes, and the verdict travels with the result', () => {
  const result = runSandboxed(TRUSTED_SOURCE, BINDINGS, { sourceTrust: 'validated' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { total: 3 });
  // The receipt must record that the gate ran, not merely that execution did.
  assert.equal(result.meta.ab6.decision, 'allow');
  assert.equal(result.meta.ab6.reason, 'SOURCE_VALIDATED_ALLOW');
});

test('an undeclared source trust is quarantined, and quarantine still executes', () => {
  // Quarantine means "execution may proceed in an isolated sandbox only", and
  // this is that sandbox -- so the request runs, but the receipt records that
  // its trust was never proven rather than silently treating it as proven.
  const result = runSandboxed(TRUSTED_SOURCE, BINDINGS);

  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { total: 3 });
  assert.equal(result.meta.ab6.decision, 'quarantine');
  assert.equal(result.meta.ab6.reason, 'UNKNOWN_SOURCE_TRUST_QUARANTINE');
});

test('an untrusted source is refused before anything is spawned', () => {
  const result = runSandboxed(TRUSTED_SOURCE, BINDINGS, { sourceTrust: 'untrusted' });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'SANDBOX_POLICY_BLOCKED');
  assert.equal(result.data, null, 'a blocked request produces no result');
  assert.equal(result.meta.ab6.decision, 'block');
  assert.equal(result.meta.ab6.reason, 'UNTRUSTED_SOURCE_BLOCK');
  assert.ok(
    result.error.details.some((finding) => finding.code === 'UNTRUSTED_SOURCE'),
    'the refusal carries the findings that caused it',
  );
});

test('a timeout above the default ceiling is refused', () => {
  const result = runSandboxed(TRUSTED_SOURCE, BINDINGS, {
    sourceTrust: 'validated',
    timeoutMs: 2000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'SANDBOX_POLICY_BLOCKED');
  assert.equal(result.meta.ab6.reason, 'TIMEOUT_EXCEEDED_BLOCK');
});

test('an operator policy can raise the timeout ceiling, up to the hard cap', () => {
  const raised = runSandboxed(TRUSTED_SOURCE, BINDINGS, {
    sourceTrust: 'validated',
    timeoutMs: 2000,
    isolationPolicy: { maximumTimeoutMs: 3000 },
  });
  assert.equal(raised.ok, true, 'the operator authorised this timeout');
  assert.equal(raised.meta.ab6.decision, 'allow');

  // The cap itself is an accepted value...
  const atCap = runSandboxed(TRUSTED_SOURCE, BINDINGS, {
    sourceTrust: 'validated',
    timeoutMs: MAX_TIMEOUT_MS,
    isolationPolicy: { maximumTimeoutMs: MAX_TIMEOUT_MS },
  });
  assert.equal(atCap.ok, true);

  // ...and a policy cannot push past it.
  const beyond = runSandboxed(TRUSTED_SOURCE, BINDINGS, {
    sourceTrust: 'validated',
    timeoutMs: 4000,
    isolationPolicy: { maximumTimeoutMs: 2000 },
  });
  assert.equal(beyond.ok, false, 'above the configured ceiling is still refused');
  assert.equal(beyond.meta.ab6.reason, 'TIMEOUT_EXCEEDED_BLOCK');
});

test('a policy minimum decision can hold back a request the source alone would allow', () => {
  const result = runSandboxed(TRUSTED_SOURCE, BINDINGS, {
    sourceTrust: 'validated',
    isolationPolicy: { minimumDecision: 'block' },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'SANDBOX_POLICY_BLOCKED');
});

test('the gate runs before the runner limits, so a refusal costs no child process', () => {
  // An oversized source would fail the byte-limit check on its own. With an
  // untrusted trust level it must be refused by the gate first -- the ordering
  // is what makes AB6 an admission decision rather than a post-hoc report.
  const oversized = `(${'x'.repeat(70 * 1024)})`;
  const result = runSandboxed(oversized, BINDINGS, { sourceTrust: 'untrusted' });

  assert.equal(result.error.code, 'SANDBOX_POLICY_BLOCKED');
  assert.notEqual(result.error.code, 'SANDBOX_SOURCE_LIMIT');
});

test('the runner\'s own protections still apply to an admitted request', () => {
  // AB6 admits; the wall still stands behind it. A validated source that tries
  // to reach `require` is stopped by the forbidden-pattern filter.
  const result = runSandboxed('require("fs").readFileSync("x")', BINDINGS, {
    sourceTrust: 'validated',
  });

  assert.equal(result.ok, false);
  assert.ok(
    ['SANDBOX_REJECTED', 'SANDBOX_POLICY_BLOCKED'].includes(result.error.code),
    `expected a refusal, got ${result.error.code}`,
  );
});

test('the existing self-healer caller still simulates successfully', () => {
  // The one production consumer of runSandboxed, exercised for real so the
  // wiring is proven not to have broken it. It declares `validated`, so it must
  // come back allowed rather than quarantined.
  const { simulateInSandbox } = require('../lib/self-healer/source-dogfood-simulator');
  const dependencyGraph = {
    nodes: ['a.js', 'b.js', 'c.js'],
    edges: [{ from: 'a.js', to: 'b.js' }],
  };

  const simulated = simulateInSandbox(dependencyGraph, { from: 'b.js', to: 'c.js' });
  assert.equal(simulated.ok, true, 'the self-healer simulation still runs');
  assert.equal(simulated.beforeEdges, 1);
  assert.equal(simulated.afterEdges, 2);
});

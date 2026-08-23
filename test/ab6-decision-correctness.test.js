'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  evaluateSandboxIsolation,
  SANDBOX_ISOLATION_REASONS,
  RUNNER_TYPES,
  MAX_TIMEOUT_MS,
} = require('../lib/sandbox-isolation');

const VALID_SOURCE = '({ total: input.a })';

function evaluate(overrides = {}, policy) {
  return evaluateSandboxIsolation(
    {
      source: VALID_SOURCE,
      sourceTrust: 'validated',
      runner: RUNNER_TYPES.NODE_VM,
      timeoutMs: 100,
      ...overrides,
    },
    policy ? { policy } : {},
  );
}

test('#1112 an unknown runner is reported as an unknown runner', () => {
  const result = evaluate({ runner: 'v8-isolate' });

  assert.equal(result.decision, 'block');
  assert.equal(
    result.reason,
    SANDBOX_ISOLATION_REASONS.UNKNOWN_RUNNER_BLOCK,
    'the reason string is what reaches the receipt and the audit log',
  );
  assert.notEqual(
    result.reason,
    SANDBOX_ISOLATION_REASONS.RESOURCE_EXHAUSTION_BLOCK,
    'nothing about naming an unrecognised runner concerns resources',
  );

  const finding = result.findings.find((entry) => entry.code === 'UNKNOWN_RUNNER');
  assert.ok(finding, 'the finding code is unchanged');
  assert.equal(finding.reason, SANDBOX_ISOLATION_REASONS.UNKNOWN_RUNNER_BLOCK);
});

test('#1112 every recognised runner still passes', () => {
  for (const runner of [RUNNER_TYPES.NODE_VM, RUNNER_TYPES.WORKER, RUNNER_TYPES.ISOLATED_VM]) {
    assert.equal(evaluate({ runner }).decision, 'allow', `${runner} is a known runner`);
  }
});

test('#1113 the default ceiling decides when no policy is configured', () => {
  // 1000 is the threshold that used to be hardcoded; keeping it as the default
  // means a caller that passes no policy sees the behaviour it always saw.
  assert.equal(evaluate({ timeoutMs: 500 }).decision, 'allow');
  assert.equal(evaluate({ timeoutMs: 1000 }).decision, 'allow', 'the ceiling itself is accepted');
  assert.equal(evaluate({ timeoutMs: 1001 }).decision, 'block');
  assert.equal(evaluate({ timeoutMs: 1001 }).reason, SANDBOX_ISOLATION_REASONS.TIMEOUT_EXCEEDED_BLOCK);
});

test('#1113 policy.maximumTimeoutMs actually decides', () => {
  const policy = { maximumTimeoutMs: 3000 };

  // Every one of these was blocked before, no matter what the operator set:
  // the knob had exactly one reachable configuration.
  for (const timeoutMs of [1001, 2000, 2999, 3000]) {
    assert.equal(
      evaluate({ timeoutMs }, policy).decision,
      'allow',
      `${timeoutMs}ms is inside the configured ceiling and must be allowed`,
    );
  }

  assert.equal(evaluate({ timeoutMs: 3001 }, policy).decision, 'block', 'and above it still blocks');

  // Lowering the ceiling has to work in the other direction too.
  assert.equal(evaluate({ timeoutMs: 800 }, { maximumTimeoutMs: 500 }).decision, 'block');
});

test('#1113 MAX_TIMEOUT_MS is an accepted value, not the first rejected one', () => {
  const atCap = { maximumTimeoutMs: MAX_TIMEOUT_MS };

  assert.equal(evaluate({ timeoutMs: MAX_TIMEOUT_MS }, atCap).decision, 'allow');
  assert.equal(evaluate({ timeoutMs: MAX_TIMEOUT_MS - 1 }, atCap).decision, 'allow');

  // The clamp now means something: an oversized request lands exactly at the
  // allowed maximum instead of at a value guaranteed to block.
  assert.equal(evaluate({ timeoutMs: 60000 }, atCap).decision, 'allow');
});

test('#1113 a policy cannot raise the ceiling past the hard cap', () => {
  const beyondCap = { maximumTimeoutMs: MAX_TIMEOUT_MS * 10 };
  // The request itself is clamped to MAX_TIMEOUT_MS, and the ceiling is too, so
  // the two meet exactly at the cap rather than letting the policy win.
  assert.equal(evaluate({ timeoutMs: MAX_TIMEOUT_MS }, beyondCap).decision, 'allow');
  assert.equal(evaluate({ timeoutMs: 60000 }, beyondCap).decision, 'allow');
});

test('#1113 the finding names which ceiling applied', () => {
  const withoutPolicy = evaluate({ timeoutMs: 2000 });
  const withPolicy = evaluate({ timeoutMs: 4000 }, { maximumTimeoutMs: 3000 });

  const detailOf = (result) => result.findings.find((entry) => entry.code === 'HIGH_TIMEOUT').detail;

  // An operator must be able to tell "you exceeded the limit I configured" from
  // "you exceeded a default I never changed".
  assert.match(detailOf(withoutPolicy), /default safe maximum of 1000ms/);
  assert.match(detailOf(withPolicy), /policy maximum of 3000ms/);

  // And the detail must name the timeout the caller actually asked for.
  assert.match(detailOf(withoutPolicy), /^Timeout 2000ms/);
});

test('#1113 one timeout breach produces one finding', () => {
  // The rule used to live in two places -- an unconditional check and a policy
  // check that could never be reached. With both configured to block, a single
  // breach must still be reported once.
  const result = evaluate({ timeoutMs: 4000 }, { maximumTimeoutMs: 2000 });
  const timeoutFindings = result.findings.filter(
    (entry) => entry.reason === SANDBOX_ISOLATION_REASONS.TIMEOUT_EXCEEDED_BLOCK,
  );

  assert.equal(result.decision, 'block');
  assert.equal(timeoutFindings.length, 1, 'one breach, one finding');
});

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  SANDBOX_ISOLATION_DECISIONS,
  SANDBOX_ISOLATION_REASONS,
  SANDBOX_ISOLATION_POLICY_VERSION,
  SANDBOX_RISK_LEVELS,
  SOURCE_TRUST_LEVELS,
  RUNNER_TYPES,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  evaluateSandboxIsolation,
  normalizeSandboxInput,
  normalizeSandboxIsolationDecision,
  classifySandboxOperation,
  summarizeSandboxFindings,
} = require('../lib/sandbox-isolation');

function makeInput(overrides = {}) {
  return {
    source: '({ total: input.a + input.b })',
    sourceTrust: SOURCE_TRUST_LEVELS.VALIDATED,
    runner: RUNNER_TYPES.NODE_VM,
    timeoutMs: 150,
    hasSnapshot: false,
    snapshotDepth: 0,
    snapshotCount: 0,
    isRollback: false,
    bindings: { input: { a: 1, b: 2 } },
    context: {},
    metadata: { workspaceId: 'test-workspace' },
    ...overrides,
  };
}

function evaluate(overrides = {}, options = {}) {
  return evaluateSandboxIsolation(makeInput(overrides), options);
}

describe('AB6 sandbox isolation core decisions', () => {
  it('validated source with safe runner returns allow', () => {
    const result = evaluate({
      source: '({ total: input.a + input.b })',
      sourceTrust: SOURCE_TRUST_LEVELS.VALIDATED,
      runner: RUNNER_TYPES.NODE_VM,
      timeoutMs: 150,
    });

    assert.equal(result.decision, SANDBOX_ISOLATION_DECISIONS.ALLOW);
    assert.equal(result.allowed, true);
    assert.equal(result.canExecute, true);
    assert.equal(result.canDryRun, true);
    assert.equal(result.reason, SANDBOX_ISOLATION_REASONS.SOURCE_VALIDATED_ALLOW);
    assert.equal(result.risk.level, SANDBOX_RISK_LEVELS.LOW);
  });

  it('untrusted source returns block', () => {
    const result = evaluate({
      source: '({ total: input.a + input.b })',
      sourceTrust: SOURCE_TRUST_LEVELS.UNTRUSTED,
      runner: RUNNER_TYPES.NODE_VM,
    });

    assert.equal(result.decision, SANDBOX_ISOLATION_DECISIONS.BLOCK);
    assert.equal(result.allowed, false);
    assert.equal(result.canExecute, false);
    assert.equal(result.canDryRun, false);
    assert.equal(result.reason, SANDBOX_ISOLATION_REASONS.UNTRUSTED_SOURCE_BLOCK);
    assert.equal(result.risk.level, SANDBOX_RISK_LEVELS.CRITICAL);
  });

  it('unknown runner returns block', () => {
    const result = evaluate({
      source: '({ total: input.a + input.b })',
      sourceTrust: SOURCE_TRUST_LEVELS.VALIDATED,
      runner: RUNNER_TYPES.UNKNOWN,
    });

    assert.equal(result.decision, SANDBOX_ISOLATION_DECISIONS.BLOCK);
    assert.equal(result.allowed, false);
    assert.equal(result.canDryRun, false);
    assert.equal(result.reason, SANDBOX_ISOLATION_REASONS.RESOURCE_EXHAUSTION_BLOCK);
    assert.equal(result.risk.level, SANDBOX_RISK_LEVELS.CRITICAL);
  });

  it('source with forbidden capabilities returns quarantine', () => {
    const result = evaluate({
      source: 'require("fs").readFileSync("x")',
      sourceTrust: SOURCE_TRUST_LEVELS.VALIDATED,
      runner: RUNNER_TYPES.NODE_VM,
    });

    assert.equal(result.decision, SANDBOX_ISOLATION_DECISIONS.QUARANTINE);
    assert.equal(result.allowed, false);
    assert.equal(result.canExecute, false);
    assert.equal(result.canDryRun, true);
    assert.equal(result.requiredReview, true);
    assert.equal(result.reason, SANDBOX_ISOLATION_REASONS.FORBIDDEN_CAPABILITY_QUARANTINE);
  });

  it('source with external network access returns quarantine', () => {
    const result = evaluate({
      source: 'fetch("https://evil.com/data")',
      sourceTrust: SOURCE_TRUST_LEVELS.VALIDATED,
      runner: RUNNER_TYPES.NODE_VM,
    });

    assert.equal(result.decision, SANDBOX_ISOLATION_DECISIONS.QUARANTINE);
    assert.equal(result.requiredReview, true);
    assert.equal(result.reason, SANDBOX_ISOLATION_REASONS.EXTERNAL_NETWORK_QUARANTINE);
  });

  it('temp artifact inside sandbox can allow', () => {
    const result = evaluate({
      source: 'write tmp artifact',
      sourceTrust: SOURCE_TRUST_LEVELS.VALIDATED,
      runner: RUNNER_TYPES.NODE_VM,
      context: {
        tempArtifactPath: 'C:\\sandbox\\tmp\\artifact.json',
        sandboxRoot: 'C:\\sandbox',
      },
    });

    assert.equal(result.decision, SANDBOX_ISOLATION_DECISIONS.ALLOW);
    assert.equal(result.allowed, true);
  });

  it('temp artifact outside sandbox returns quarantine', () => {
    const result = evaluate({
      source: 'write tmp artifact',
      sourceTrust: SOURCE_TRUST_LEVELS.VALIDATED,
      runner: RUNNER_TYPES.NODE_VM,
      context: {
        tempOutsideSandbox: true,
        tempArtifactPath: 'C:\\Users\\sonfi\\AppData\\Local\\Temp\\artifact.json',
        sandboxRoot: 'C:\\sandbox',
      },
    });

    assert.equal(result.decision, SANDBOX_ISOLATION_DECISIONS.QUARANTINE);
    assert.equal(result.allowed, false);
    assert.equal(result.requiredReview, true);
    assert.equal(result.reason, SANDBOX_ISOLATION_REASONS.TEMP_ARTIFACT_OUTSIDE_SANDBOX_QUARANTINE);
  });

  it('destructive cleanup outside sandbox blocks', () => {
    const result = evaluate({
      source: 'wipe temp artifacts',
      sourceTrust: SOURCE_TRUST_LEVELS.VALIDATED,
      runner: RUNNER_TYPES.NODE_VM,
      context: {
        tempOutsideSandbox: true,
        tempArtifactPath: 'C:\\Users\\sonfi\\AppData\\Local\\Temp\\artifact.json',
        sandboxRoot: 'C:\\sandbox',
      },
    });

    assert.equal(result.decision, SANDBOX_ISOLATION_DECISIONS.BLOCK);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, SANDBOX_ISOLATION_REASONS.DESTRUCTIVE_CLEANUP_OUTSIDE_SANDBOX_BLOCK);
  });

  it('missing sandbox root with temp artifacts does not allow', () => {
    const result = evaluate({
      source: 'write tmp artifact',
      sourceTrust: SOURCE_TRUST_LEVELS.VALIDATED,
      runner: RUNNER_TYPES.NODE_VM,
      context: {
        tempArtifactPath: 'C:\\Users\\sonfi\\AppData\\Local\\Temp\\artifact.json',
      },
    });

    assert.equal(result.decision, SANDBOX_ISOLATION_DECISIONS.QUARANTINE);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, SANDBOX_ISOLATION_REASONS.TEMP_ARTIFACT_MISSING_SANDBOX_ROOT_QUARANTINE);
  });

  it('path traversal temp artifact does not allow', () => {
    const result = evaluate({
      source: 'write tmp artifact',
      sourceTrust: SOURCE_TRUST_LEVELS.VALIDATED,
      runner: RUNNER_TYPES.NODE_VM,
      context: {
        tempArtifactPath: 'C:\\sandbox\\..\\outside\\artifact.json',
        sandboxRoot: 'C:\\sandbox',
      },
    });

    assert.equal(result.decision, SANDBOX_ISOLATION_DECISIONS.BLOCK);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, SANDBOX_ISOLATION_REASONS.TEMP_ARTIFACT_PATH_TRAVERSAL_BLOCK);
  });

  it('Windows-style temp path outside sandbox does not allow', () => {
    const result = evaluate({
      source: 'write tmp artifact',
      sourceTrust: SOURCE_TRUST_LEVELS.VALIDATED,
      runner: RUNNER_TYPES.NODE_VM,
      context: {
        tempArtifactPath: 'C:\\Users\\sonfi\\AppData\\Local\\Temp\\artifact.json',
        sandboxRoot: 'C:\\sandbox',
      },
    });

    assert.notEqual(result.decision, SANDBOX_ISOLATION_DECISIONS.ALLOW);
    assert.equal(result.allowed, false);
  });

  it('timeout exceeding threshold returns block', () => {
    const result = evaluate({
      source: '({ total: input.a })',
      sourceTrust: SOURCE_TRUST_LEVELS.VALIDATED,
      runner: RUNNER_TYPES.NODE_VM,
      timeoutMs: 2000,
    });

    assert.equal(result.decision, SANDBOX_ISOLATION_DECISIONS.BLOCK);
    assert.equal(result.reason, SANDBOX_ISOLATION_REASONS.TIMEOUT_EXCEEDED_BLOCK);
    assert.equal(result.risk.level, SANDBOX_RISK_LEVELS.HIGH);
  });

  it('rollback with snapshot returns allow', () => {
    const result = evaluate({
      source: '',
      isRollback: true,
      hasSnapshot: true,
      snapshotDepth: 1,
    });

    assert.equal(result.decision, SANDBOX_ISOLATION_DECISIONS.ALLOW);
    assert.equal(result.canRollback, true);
    assert.equal(result.reason, SANDBOX_ISOLATION_REASONS.SNAPSHOT_RESTORE_ALLOW);
  });

  it('rollback without snapshot returns rollback decision', () => {
    const result = evaluate({
      source: '',
      isRollback: true,
      hasSnapshot: false,
    });

    assert.equal(result.decision, SANDBOX_ISOLATION_DECISIONS.ROLLBACK);
    assert.equal(result.canRollback, false);
    assert.equal(result.reason, SANDBOX_ISOLATION_REASONS.ROLLBACK_FAILED_ROLLBACK);
    assert.equal(result.risk.level, SANDBOX_RISK_LEVELS.HIGH);
  });

  it('snapshot abuse with high count returns block', () => {
    const result = evaluate({
      source: '({ total: input.a })',
      sourceTrust: SOURCE_TRUST_LEVELS.VALIDATED,
      runner: RUNNER_TYPES.NODE_VM,
      snapshotCount: 60,
    });

    assert.equal(result.decision, SANDBOX_ISOLATION_DECISIONS.BLOCK);
    assert.equal(result.reason, SANDBOX_ISOLATION_REASONS.SNAPSHOT_ABUSE_BLOCK);
    assert.equal(result.risk.level, SANDBOX_RISK_LEVELS.CRITICAL);
  });

  it('snapshot abuse with high depth returns block', () => {
    const result = evaluate({
      source: '({ total: input.a })',
      sourceTrust: SOURCE_TRUST_LEVELS.VALIDATED,
      runner: RUNNER_TYPES.NODE_VM,
      snapshotDepth: 25,
    });

    assert.equal(result.decision, SANDBOX_ISOLATION_DECISIONS.BLOCK);
    assert.equal(result.reason, SANDBOX_ISOLATION_REASONS.SNAPSHOT_ABUSE_BLOCK);
  });

  it('unknown source trust requires quarantine before execution', () => {
    const result = evaluate({
      source: '({ total: input.a })',
      sourceTrust: SOURCE_TRUST_LEVELS.UNKNOWN,
      runner: RUNNER_TYPES.NODE_VM,
    });

    assert.equal(result.decision, SANDBOX_ISOLATION_DECISIONS.QUARANTINE);
    assert.equal(result.allowed, false);
    assert.equal(result.canExecute, false);
    assert.equal(result.canDryRun, true);
    assert.equal(result.requiredReview, true);
    assert.equal(result.reason, SANDBOX_ISOLATION_REASONS.UNKNOWN_SOURCE_TRUST_QUARANTINE);
    assert.ok(result.warnings.length > 0);
    assert.ok(result.warnings.some(w => w.includes('unknown')));
  });

  it('empty source without rollback returns quarantine', () => {
    const result = evaluate({
      source: '',
      sourceTrust: SOURCE_TRUST_LEVELS.VALIDATED,
      runner: RUNNER_TYPES.NODE_VM,
      isRollback: false,
    });

    assert.equal(result.decision, SANDBOX_ISOLATION_DECISIONS.QUARANTINE);
    assert.equal(result.reason, SANDBOX_ISOLATION_REASONS.SANDBOX_VIOLATION_QUARANTINE);
  });

  it('malformed input does not crash and does not allow', () => {
    const result = evaluateSandboxIsolation(null);
    assert.equal(result.ok, true);
    assert.equal(result.allowed, false);
    assert.ok(result.decision === SANDBOX_ISOLATION_DECISIONS.BLOCK || result.decision === SANDBOX_ISOLATION_DECISIONS.QUARANTINE);
  });

  it('undefined input does not crash and does not allow', () => {
    const result = evaluateSandboxIsolation(undefined);
    assert.equal(result.ok, true);
    assert.equal(result.allowed, false);
  });

  it('policy override can increase strictness', () => {
    const result = evaluate(
      {
        source: '({ total: input.a })',
        sourceTrust: SOURCE_TRUST_LEVELS.VALIDATED,
        runner: RUNNER_TYPES.NODE_VM,
      },
      { policy: { minimumDecision: 'block' } }
    );

    assert.equal(result.decision, SANDBOX_ISOLATION_DECISIONS.BLOCK);
    assert.equal(result.allowed, false);
  });

  it('policy override cannot downgrade critical to allow', () => {
    const result = evaluate(
      {
        source: '({ total: input.a })',
        sourceTrust: SOURCE_TRUST_LEVELS.UNTRUSTED,
        runner: RUNNER_TYPES.NODE_VM,
      },
      { policy: { minimumDecision: 'allow', allowUntustedSource: true } }
    );

    assert.equal(result.decision, SANDBOX_ISOLATION_DECISIONS.BLOCK);
    assert.equal(result.allowed, false);
  });

  it('policy max timeout enforced', () => {
    const result = evaluate(
      {
        source: '({ total: input.a })',
        sourceTrust: SOURCE_TRUST_LEVELS.VALIDATED,
        runner: RUNNER_TYPES.NODE_VM,
        timeoutMs: 800,
      },
      { policy: { maximumTimeoutMs: 500 } }
    );

    assert.equal(result.decision, SANDBOX_ISOLATION_DECISIONS.BLOCK);
    assert.equal(result.allowed, false);
  });

  it('policy external network blocked', () => {
    const result = evaluate(
      {
        source: 'fetch("https://example.com")',
        sourceTrust: SOURCE_TRUST_LEVELS.VALIDATED,
        runner: RUNNER_TYPES.NODE_VM,
      },
      { policy: { allowExternalNetwork: false } }
    );

    assert.equal(result.decision, SANDBOX_ISOLATION_DECISIONS.BLOCK);
    assert.equal(result.allowed, false);
  });

  it('gate never executes provided callback', () => {
    let called = false;
    evaluate(
      {
        source: '({ total: input.a })',
        sourceTrust: SOURCE_TRUST_LEVELS.VALIDATED,
        runner: RUNNER_TYPES.NODE_VM,
      },
      { policy: { callback: () => { called = true; } } }
    );
    assert.equal(called, false);
  });

  it('same input produces same output', () => {
    const input = makeInput({
      source: '({ total: input.a + input.b })',
      sourceTrust: SOURCE_TRUST_LEVELS.VALIDATED,
      runner: RUNNER_TYPES.NODE_VM,
    });
    const result1 = evaluateSandboxIsolation(input);
    const result2 = evaluateSandboxIsolation(input);
    assert.deepEqual(result1, result2);
  });

  it('findings include per-risk reasons and summary is deterministic', () => {
    const result = evaluate({
      source: 'require("fs").readFileSync("x")',
      sourceTrust: SOURCE_TRUST_LEVELS.VALIDATED,
      runner: RUNNER_TYPES.NODE_VM,
    });

    assert.ok(result.findings.length > 0);
    for (const f of result.findings) {
      assert.ok(f.code, 'finding has code');
      assert.ok(f.decision, 'finding has decision');
      assert.ok(f.reason, 'finding has reason');
      assert.ok(f.risk, 'finding has risk');
    }
    const summary1 = summarizeSandboxFindings(result.findings);
    const summary2 = summarizeSandboxFindings(result.findings);
    assert.deepEqual(summary1, summary2);
  });

  it('normalizeSandboxIsolationDecision keeps output shape stable', () => {
    const result = evaluate({
      source: '({ total: input.a })',
      sourceTrust: SOURCE_TRUST_LEVELS.VALIDATED,
      runner: RUNNER_TYPES.NODE_VM,
    });
    const normalized = normalizeSandboxIsolationDecision(result);
    assert.equal(typeof normalized.ok, 'boolean');
    assert.equal(typeof normalized.allowed, 'boolean');
    assert.equal(typeof normalized.canExecute, 'boolean');
    assert.equal(typeof normalized.canDryRun, 'boolean');
    assert.equal(typeof normalized.canRollback, 'boolean');
    assert.equal(typeof normalized.decision, 'string');
    assert.equal(typeof normalized.reason, 'string');
    assert.ok(normalized.risk);
    assert.equal(typeof normalized.risk.level, 'string');
    assert.equal(typeof normalized.risk.score, 'number');
    assert.equal(typeof normalized.requiredReview, 'boolean');
    assert.equal(typeof normalized.dryRunOnly, 'boolean');
    assert.ok(Array.isArray(normalized.findings));
    assert.ok(normalized.summary);
    assert.ok(Array.isArray(normalized.warnings));
    assert.ok(normalized.metadata);
  });

  it('output shape is stable', () => {
    const result = evaluate({
      source: '({ total: input.a })',
      sourceTrust: SOURCE_TRUST_LEVELS.VALIDATED,
      runner: RUNNER_TYPES.NODE_VM,
    });

    const expectedKeys = [
      'ok', 'allowed', 'canExecute', 'canDryRun', 'canRollback',
      'decision', 'reason', 'risk', 'requiredReview', 'dryRunOnly',
      'findings', 'summary', 'warnings', 'metadata',
    ];
    const actualKeys = Object.keys(result);
    assert.deepEqual(actualKeys, expectedKeys);
  });

  it('dry-run-only sets canExecute false and canDryRun true', () => {
    const result = evaluate(
      {
        source: 'require("fs").readFileSync("x")',
        sourceTrust: SOURCE_TRUST_LEVELS.VALIDATED,
        runner: RUNNER_TYPES.NODE_VM,
      },
      { policy: { minimumDecision: 'quarantine' } }
    );

    assert.equal(result.canExecute, false);
    assert.equal(result.canDryRun, true);
    assert.equal(result.decision, SANDBOX_ISOLATION_DECISIONS.QUARANTINE);
  });

  it('block sets allowed false and canDryRun false', () => {
    const result = evaluate({
      source: '({ total: input.a })',
      sourceTrust: SOURCE_TRUST_LEVELS.UNTRUSTED,
      runner: RUNNER_TYPES.NODE_VM,
    });

    assert.equal(result.allowed, false);
    assert.equal(result.canDryRun, false);
    assert.equal(result.decision, SANDBOX_ISOLATION_DECISIONS.BLOCK);
  });

  it('quarantine decision sets requiredReview true', () => {
    const result = evaluate({
      source: 'require("fs").readFileSync("x")',
      sourceTrust: SOURCE_TRUST_LEVELS.VALIDATED,
      runner: RUNNER_TYPES.NODE_VM,
    });

    assert.equal(result.decision, SANDBOX_ISOLATION_DECISIONS.QUARANTINE);
    assert.equal(result.requiredReview, true);
  });

  it('metadata includes workspaceId', () => {
    const result = evaluate({
      source: '({ total: input.a })',
      sourceTrust: SOURCE_TRUST_LEVELS.VALIDATED,
      runner: RUNNER_TYPES.NODE_VM,
      metadata: { workspaceId: 'my-workspace' },
    });

    assert.equal(result.metadata.workspaceId, 'my-workspace');
    assert.equal(result.metadata.policyVersion, SANDBOX_ISOLATION_POLICY_VERSION);
  });

  it('policy version is stable', () => {
    assert.equal(SANDBOX_ISOLATION_POLICY_VERSION, 'AB6-v0.1.0');
  });

  it('decisions enum is frozen', () => {
    assert.throws(() => {
      SANDBOX_ISOLATION_DECISIONS.NEW_VALUE = 'test';
    });
  });

  it('risk levels enum is frozen', () => {
    assert.throws(() => {
      SANDBOX_RISK_LEVELS.NEW_VALUE = 'test';
    });
  });

  it('reasons enum is frozen', () => {
    assert.throws(() => {
      SANDBOX_ISOLATION_REASONS.NEW_VALUE = 'test';
    });
  });

  it('worker runner with validated source returns allow', () => {
    const result = evaluate({
      source: '({ total: input.a })',
      sourceTrust: SOURCE_TRUST_LEVELS.VALIDATED,
      runner: RUNNER_TYPES.WORKER,
    });

    assert.equal(result.decision, SANDBOX_ISOLATION_DECISIONS.ALLOW);
  });

  it('isolated-vm runner with validated source returns allow', () => {
    const result = evaluate({
      source: '({ total: input.a })',
      sourceTrust: SOURCE_TRUST_LEVELS.VALIDATED,
      runner: RUNNER_TYPES.ISOLATED_VM,
    });

    assert.equal(result.decision, SANDBOX_ISOLATION_DECISIONS.ALLOW);
  });

  it('policy max snapshot depth enforced', () => {
    const result = evaluate(
      {
        source: '({ total: input.a })',
        sourceTrust: SOURCE_TRUST_LEVELS.VALIDATED,
        runner: RUNNER_TYPES.NODE_VM,
        snapshotDepth: 10,
      },
      { policy: { maxSnapshotDepth: 5 } }
    );

    assert.equal(result.decision, SANDBOX_ISOLATION_DECISIONS.BLOCK);
    assert.equal(result.allowed, false);
  });
});

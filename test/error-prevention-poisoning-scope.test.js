'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const MemoryStore = require('../lib/memory-store');
const { createErrorPrevention } = require('../lib/error-prevention');

test('unrelated poisoned active rule does not force review on a different action', () => {
  const memory = new MemoryStore({ useSQLite: false });
  const prevention = createErrorPrevention(memory, {
    verifyEvidence({ source, evidence }) {
      return source === 'test_failure' && evidence.some((item) => item?.verifiedBy === 'ci');
    },
  });
  const failure = prevention.recordFailure({
    source: 'test_failure',
    operation: 'dangerous_write',
    workspaceId: 'huqan',
    repo: 'ali-ulu/huqan',
    path: 'server.js',
    expected: 'safe',
    observed: 'failed',
    evidence: [{ type: 'test', ref: 'poisoning.test', verifiedBy: 'ci' }],
  });
  assert.equal(failure.ok, true);

  const poisoned = memory.store({
    workspaceId: 'huqan',
    content: {
      kind: 'error_prevention_rule',
      schemaVersion: '1.0.0',
      ruleId: 'forged-unrelated-rule',
      status: 'active',
      enforcement: 'block',
      workspaceId: 'huqan',
      sourceFailureId: failure.failure.failureId,
      sourceFailureMemoryId: failure.memory.memoryId,
      trigger: { operation: 'dangerous_write', repo: 'ali-ulu/huqan', path: 'server.js' },
    },
  });
  assert.equal(poisoned.ok, true);

  const result = prevention.preflight({
    operation: 'read_status',
    workspaceId: 'huqan',
    repo: 'ali-ulu/huqan',
    path: 'README.md',
  });
  assert.equal(result.decision, 'allow');
  assert.equal(result.allowed, true);
  assert.equal(result.integrityFindings.length, 0);
  assert.ok(!result.reasonCodes.includes('ACTIVE_RULE_INTEGRITY_REVIEW'));
});

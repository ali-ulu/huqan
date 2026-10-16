'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const MemoryStore = require('../lib/memory-store');
const {
  buildActionFingerprint,
  createErrorPrevention,
  normalizeAction,
} = require('../lib/error-prevention');

function baseAction(path) {
  return {
    tool: 'edit',
    operation: 'modify_http_body_limit',
    workspaceId: 'huqan',
    repo: 'ali-ulu/huqan',
    path,
  };
}

function makeEngine() {
  const memory = new MemoryStore({ useSQLite: false });
  const prevention = createErrorPrevention(memory, {
    verifyEvidence({ source, evidence }) {
      return source === 'test_failure'
        && evidence.some((item) => item?.type === 'test' && item?.verifiedBy === 'ci');
    },
    resolveApproval({ approvalIdHint, rule, workspaceId, ruleSubjectHash }) {
      return {
        approvalId: approvalIdHint,
        status: approvalIdHint === 'approval-authoritative' ? 'approved' : 'pending',
        ruleId: rule?.ruleId || '',
        workspaceId,
        ruleSubjectHash,
      };
    },
  });
  return prevention;
}

test('repo-relative lexical aliases normalize identically without widening scope', () => {
  const canonical = baseAction('server.js');
  const aliases = [
    baseAction('./server.js'),
    baseAction('src/../server.js'),
    baseAction('.\\server.js'),
  ];

  assert.equal(normalizeAction(canonical).path, 'server.js');
  for (const alias of aliases) {
    assert.equal(normalizeAction(alias).path, 'server.js');
    assert.equal(buildActionFingerprint(alias), buildActionFingerprint(canonical));
  }

  const outOfScope = [
    baseAction('../server.js'),
    baseAction('/server.js'),
    baseAction('C:\\repo\\server.js'),
    baseAction('README.md'),
  ];
  for (const action of outOfScope) {
    assert.notEqual(normalizeAction(action).path, 'server.js');
    assert.notEqual(buildActionFingerprint(action), buildActionFingerprint(canonical));
  }
});

test('active prevention rule matches equivalent path aliases and preserves repo/workspace boundaries', () => {
  const prevention = makeEngine();
  const failure = prevention.recordFailure({
    ...baseAction('server.js'),
    source: 'test_failure',
    expected: 'HTTP 413',
    observed: 'ECONNRESET',
    evidence: [{ type: 'test', ref: 'path-normalization.test.js', verifiedBy: 'ci' }],
  });
  assert.equal(failure.ok, true);

  const proposed = prevention.proposeRule(failure.memory.memoryId, {
    workspaceId: 'huqan',
    enforcement: 'block',
  });
  assert.equal(proposed.ok, true);

  const active = prevention.activateRule(proposed.memory.memoryId, {
    workspaceId: 'huqan',
    approvalId: 'approval-authoritative',
  });
  assert.equal(active.ok, true);

  for (const alias of ['./server.js', 'src/../server.js', '.\\server.js']) {
    const result = prevention.preflight(baseAction(alias));
    assert.equal(result.decision, 'block', alias);
    assert.equal(result.blocked, true, alias);
    assert.equal(result.matchedRules.length, 1, alias);
  }

  for (const differentPath of ['../server.js', '/server.js', 'README.md']) {
    const result = prevention.preflight(baseAction(differentPath));
    assert.equal(result.decision, 'allow', differentPath);
    assert.equal(result.matchedRules.length, 0, differentPath);
  }

  const otherWorkspace = prevention.preflight({ ...baseAction('./server.js'), workspaceId: 'other' });
  assert.equal(otherWorkspace.decision, 'allow');
  assert.equal(otherWorkspace.matchedRules.length, 0);
});

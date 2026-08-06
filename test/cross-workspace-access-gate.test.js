'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CROSS_WORKSPACE_DECISIONS,
  CROSS_WORKSPACE_REASONS,
  classifyOperation,
  evaluateCrossWorkspaceAccess,
} = require('../lib/cross-workspace-access-gate');

const READ_GRANT = { fromWorkspaceId: 'ws-a', toWorkspaceId: 'ws-b', operations: ['read'] };
const WRITE_GRANT = { fromWorkspaceId: 'ws-a', toWorkspaceId: 'ws-b', operations: ['write'] };

// ─── same workspace ──────────────────────────────────────────────────────────

test('same workspace access is allowed', () => {
  const r = evaluateCrossWorkspaceAccess({
    actorWorkspaceId: 'ws-a', targetWorkspaceId: 'ws-a', operation: 'read',
  });
  assert.equal(r.decision, CROSS_WORKSPACE_DECISIONS.ALLOW);
  assert.equal(r.reason, CROSS_WORKSPACE_REASONS.SAME_WORKSPACE);
  assert.equal(r.crossWorkspace, false);
});

test('surrounding whitespace does not create a false boundary', () => {
  const r = evaluateCrossWorkspaceAccess({
    actorWorkspaceId: '  ws-a  ', targetWorkspaceId: 'ws-a', operation: 'write',
  });
  assert.equal(r.decision, CROSS_WORKSPACE_DECISIONS.ALLOW);
});

test('workspace comparison is case-sensitive, matching storage', () => {
  // graph.js normalizeWorkspaceId trims without lowering, so these are
  // genuinely different storage scopes. Treating them as one would wave
  // through an access that storage considers a boundary crossing.
  const r = evaluateCrossWorkspaceAccess({
    actorWorkspaceId: 'ws-a', targetWorkspaceId: 'WS-A', operation: 'read',
  });
  assert.equal(r.decision, CROSS_WORKSPACE_DECISIONS.BLOCK);
  assert.equal(r.crossWorkspace, true);
});

// ─── missing workspace is refused, not defaulted ─────────────────────────────

test('a missing actor workspace is refused rather than defaulted', () => {
  for (const actorWorkspaceId of [undefined, null, '', '   ', 42, {}]) {
    const r = evaluateCrossWorkspaceAccess({
      actorWorkspaceId, targetWorkspaceId: 'ws-b', operation: 'read',
    });
    assert.equal(r.decision, CROSS_WORKSPACE_DECISIONS.BLOCK, `${String(actorWorkspaceId)} must not pass`);
    assert.equal(r.reason, CROSS_WORKSPACE_REASONS.WORKSPACE_REQUIRED);
  }
});

test('a missing target workspace is refused', () => {
  const r = evaluateCrossWorkspaceAccess({ actorWorkspaceId: 'ws-a', operation: 'read' });
  assert.equal(r.decision, CROSS_WORKSPACE_DECISIONS.BLOCK);
  assert.equal(r.reason, CROSS_WORKSPACE_REASONS.WORKSPACE_REQUIRED);
});

test('two unidentified callers are not treated as sharing a workspace', () => {
  const r = evaluateCrossWorkspaceAccess({ operation: 'read' });
  assert.equal(r.decision, CROSS_WORKSPACE_DECISIONS.BLOCK,
    'defaulting both sides to "default" would grant an unidentified caller the default workspace');
});

// ─── unknown operations fail closed ──────────────────────────────────────────

test('an unclassifiable operation is refused', () => {
  for (const operation of ['frobnicate', '', undefined, 'exec']) {
    const r = evaluateCrossWorkspaceAccess({
      actorWorkspaceId: 'ws-a', targetWorkspaceId: 'ws-a', operation,
    });
    assert.equal(r.decision, CROSS_WORKSPACE_DECISIONS.BLOCK,
      `${String(operation)} might be a write; it must not be assumed harmless`);
    assert.equal(r.reason, CROSS_WORKSPACE_REASONS.UNKNOWN_OPERATION);
  }
});

test('classifyOperation maps destructive verbs to write', () => {
  assert.equal(classifyOperation('delete'), 'write');
  assert.equal(classifyOperation('remove'), 'write');
  assert.equal(classifyOperation('learn'), 'write');
  assert.equal(classifyOperation('read'), 'read');
  assert.equal(classifyOperation('anything-else'), '');
});

// ─── cross-workspace without a grant ─────────────────────────────────────────

test('cross-workspace read is denied by default', () => {
  const r = evaluateCrossWorkspaceAccess({
    actorWorkspaceId: 'ws-a', targetWorkspaceId: 'ws-b', operation: 'read',
  });
  assert.equal(r.decision, CROSS_WORKSPACE_DECISIONS.BLOCK);
  assert.equal(r.reason, CROSS_WORKSPACE_REASONS.CROSS_WORKSPACE_DENIED);
  assert.equal(r.crossWorkspace, true);
});

test('cross-workspace write is denied by default', () => {
  const r = evaluateCrossWorkspaceAccess({
    actorWorkspaceId: 'ws-a', targetWorkspaceId: 'ws-b', operation: 'learn',
  });
  assert.equal(r.decision, CROSS_WORKSPACE_DECISIONS.BLOCK);
});

// ─── grants ──────────────────────────────────────────────────────────────────

test('a granted cross-workspace read is allowed', () => {
  const r = evaluateCrossWorkspaceAccess({
    actorWorkspaceId: 'ws-a', targetWorkspaceId: 'ws-b', operation: 'read', grants: [READ_GRANT],
  });
  assert.equal(r.decision, CROSS_WORKSPACE_DECISIONS.ALLOW);
  assert.equal(r.reason, CROSS_WORKSPACE_REASONS.CROSS_WORKSPACE_READ_GRANTED);
});

test('a granted cross-workspace write still requires review', () => {
  const r = evaluateCrossWorkspaceAccess({
    actorWorkspaceId: 'ws-a', targetWorkspaceId: 'ws-b', operation: 'update', grants: [WRITE_GRANT],
  });
  assert.equal(r.decision, CROSS_WORKSPACE_DECISIONS.REVIEW,
    'a grant says the boundary may be crossed, not that this mutation is intended');
});

test('a read grant does not authorize a write', () => {
  const r = evaluateCrossWorkspaceAccess({
    actorWorkspaceId: 'ws-a', targetWorkspaceId: 'ws-b', operation: 'delete', grants: [READ_GRANT],
  });
  assert.equal(r.decision, CROSS_WORKSPACE_DECISIONS.BLOCK);
});

test('a grant does not work in the reverse direction', () => {
  const r = evaluateCrossWorkspaceAccess({
    actorWorkspaceId: 'ws-b', targetWorkspaceId: 'ws-a', operation: 'read', grants: [READ_GRANT],
  });
  assert.equal(r.decision, CROSS_WORKSPACE_DECISIONS.BLOCK,
    'grants are directional');
});

test('a grant for a different workspace pair does not apply', () => {
  const r = evaluateCrossWorkspaceAccess({
    actorWorkspaceId: 'ws-a', targetWorkspaceId: 'ws-c', operation: 'read', grants: [READ_GRANT],
  });
  assert.equal(r.decision, CROSS_WORKSPACE_DECISIONS.BLOCK);
});

test('grant workspace matching is case-sensitive', () => {
  const r = evaluateCrossWorkspaceAccess({
    actorWorkspaceId: 'ws-a',
    targetWorkspaceId: 'ws-b',
    operation: 'read',
    grants: [{ fromWorkspaceId: 'WS-A', toWorkspaceId: 'ws-b', operations: ['read'] }],
  });
  assert.equal(r.decision, CROSS_WORKSPACE_DECISIONS.BLOCK);
});

test('there is no wildcard grant', () => {
  for (const grant of [
    { fromWorkspaceId: '*', toWorkspaceId: 'ws-b', operations: ['read'] },
    { fromWorkspaceId: 'ws-a', toWorkspaceId: '*', operations: ['read'] },
    { fromWorkspaceId: 'ws-a', toWorkspaceId: 'ws-b', operations: ['*'] },
  ]) {
    const r = evaluateCrossWorkspaceAccess({
      actorWorkspaceId: 'ws-a', targetWorkspaceId: 'ws-b', operation: 'read', grants: [grant],
    });
    assert.equal(r.decision, CROSS_WORKSPACE_DECISIONS.BLOCK,
      'a wildcard in a tenant-isolation gate would be a standing hole');
  }
});

test('malformed grants are ignored rather than trusted', () => {
  for (const grants of ['nope', [null], [{}], [{ fromWorkspaceId: 'ws-a' }], [{ operations: ['read'] }]]) {
    const r = evaluateCrossWorkspaceAccess({
      actorWorkspaceId: 'ws-a', targetWorkspaceId: 'ws-b', operation: 'read', grants,
    });
    assert.equal(r.decision, CROSS_WORKSPACE_DECISIONS.BLOCK);
  }
});

test('malformed input does not throw and does not allow', () => {
  for (const input of [undefined, null, 'nope', 42, []]) {
    const r = evaluateCrossWorkspaceAccess(input);
    assert.equal(r.ok, true);
    assert.equal(r.allowed, false);
  }
});

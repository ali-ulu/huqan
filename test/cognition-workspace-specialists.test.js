'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SPECIALIST_NAMES, SPECIALIST_PROPOSAL_KINDS,
  createSpecialist, createSpecialists, withProposalFn,
} = require('../lib/cognition/workspace-specialists');
const { AUTHORITY } = require('../lib/cognition/contract');

test('SPECIALIST_NAMES is a closed set', () => {
  assert.deepEqual(SPECIALIST_NAMES, ['scheduler', 'dream', 'dual-process-router', 'replay']);
  assert.equal(Object.isFrozen(SPECIALIST_NAMES), true);
});

test('each specialist has exactly one allowed proposal kind', () => {
  assert.equal(SPECIALIST_PROPOSAL_KINDS.scheduler, 'annotate-urgency');
  assert.equal(SPECIALIST_PROPOSAL_KINDS.dream, 'focus-hypothesis');
  assert.equal(SPECIALIST_PROPOSAL_KINDS['dual-process-router'], 'route-advice');
  assert.equal(SPECIALIST_PROPOSAL_KINDS.replay, 'replay-tag');
  assert.equal(Object.isFrozen(SPECIALIST_PROPOSAL_KINDS), true);
});

test('createSpecialist rejects unknown names', () => {
  const s = createSpecialist('unknown', () => []);
  assert.equal(s, null);
});

test('createSpecialist rejects non-function proposals', () => {
  const s = createSpecialist('scheduler', 'not a function');
  assert.equal(s, null);
});

test('createSpecialist returns frozen specialist with correct kind', () => {
  const s = createSpecialist('scheduler', () => []);
  assert.ok(s);
  assert.equal(s.name, 'scheduler');
  assert.equal(s.kind, 'annotate-urgency');
  assert.equal(s.authority, AUTHORITY.PROPOSAL_ONLY);
  assert.equal(typeof s.fn, 'function');
  assert.equal(Object.isFrozen(s), true);
});

test('createSpecialists returns all specialists with empty proposals', () => {
  const specialists = createSpecialists();
  assert.equal(specialists.length, SPECIALIST_NAMES.length);
  for (const s of specialists) {
    assert.ok(SPECIALIST_NAMES.includes(s.name));
    assert.equal(s.kind, SPECIALIST_PROPOSAL_KINDS[s.name]);
    assert.deepEqual(s.fn(), []);
  }
});

test('withProposalFn replaces the proposal function', () => {
  const s = createSpecialist('dream', () => []);
  const newFn = (scene) => [{ kind: 'focus-hypothesis', target: scene.contents[0]?.key, payload: { h: 1 } }];
  const updated = withProposalFn(s, newFn);
  assert.notEqual(updated, s);
  assert.equal(updated.name, 'dream');
  assert.equal(updated.kind, 'focus-hypothesis');
  const mockScene = { contents: [{ key: 'a' }] };
  const proposals = updated.fn(mockScene);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].target, 'a');
});

test('withProposalFn handles invalid input', () => {
  assert.equal(withProposalFn(null, () => []), null);
  const s = createSpecialist('scheduler', () => []);
  assert.equal(withProposalFn(s, 'not a function'), s);
});

test('specialists are pure functions with no side effects', () => {
  const specialists = createSpecialists();
  const scene = { contents: [{ key: 'a', strength: 0.8 }] };
  const view = { goal: 'test' };

  for (const s of specialists) {
    const r1 = s.fn(scene, view);
    const r2 = s.fn(scene, view);
    assert.deepEqual(r1, r2);
  }
});

test('specialist authority is always PROPOSAL_ONLY', () => {
  const specialists = createSpecialists();
  for (const s of specialists) {
    assert.equal(s.authority, AUTHORITY.PROPOSAL_ONLY);
  }
});

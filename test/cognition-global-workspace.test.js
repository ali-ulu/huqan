'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SCHEMA_VERSION, IGNITION_THRESHOLD, BROADCAST_WIDTH, MIN_MARGIN,
  REFRACTORY_CYCLES, CAPTURE_OVERRIDE, MAX_SCENES, MAX_PROPOSALS_PER_SCENE,
  ALLOWED_PROPOSAL_KINDS, createScene, compete, broadcast,
} = require('../lib/cognition/global-workspace');
const { AUTHORITY } = require('../lib/cognition/contract');

function createMockWorkingMemory(items) {
  return {
    schemaVersion: 'huqan-cognition-working-memory-v1',
    items: items.map((item) => ({
      key: item.key,
      perceptId: item.perceptId || null,
      activation: item.activation,
      salience: item.salience || item.activation,
      enteredAt: item.enteredAt || 0,
      lastRehearsedAt: item.lastRehearsedAt || 0,
    })),
  };
}

test('constants are defined', () => {
  assert.equal(SCHEMA_VERSION, 'huqan-cognition-workspace-v1');
  assert.equal(IGNITION_THRESHOLD, 0.5);
  assert.equal(BROADCAST_WIDTH, 2);
  assert.equal(MIN_MARGIN, 0.05);
  assert.equal(REFRACTORY_CYCLES, 2);
  assert.equal(CAPTURE_OVERRIDE, 0.9);
  assert.equal(MAX_SCENES, 16);
  assert.equal(MAX_PROPOSALS_PER_SCENE, 8);
  assert.deepEqual(ALLOWED_PROPOSAL_KINDS, ['annotate-urgency', 'focus-hypothesis', 'route-advice', 'replay-tag']);
});

test('does not ignite below IGNITION_THRESHOLD', () => {
  const wm = createMockWorkingMemory([
    { key: 'a', activation: 0.3 },
    { key: 'b', activation: 0.4 },
  ]);
  const { scene } = compete(wm, 3);
  assert.equal(scene.status, 'SUBTHRESHOLD');
  assert.equal(scene.contents.length, 0);
  assert.equal(scene.proposals.length, 0);
});

test('ignites when strength reaches IGNITION_THRESHOLD', () => {
  const wm = createMockWorkingMemory([{ key: 'a', activation: 0.6 }]);
  const { scene } = compete(wm, 2);
  assert.equal(scene.status, 'IGNITED');
  assert.equal(scene.contents.length, 1);
  assert.equal(scene.contents[0].key, 'a');
  assert.ok(scene.contents[0].strength >= IGNITION_THRESHOLD);
});

test('refractory rule prevents capture by one key', () => {
  const wm = createMockWorkingMemory([{ key: 'a', activation: 0.8 }]);

  let refractoryState = { wins: [] };
  const r1 = compete(wm, 2, refractoryState);
  assert.equal(r1.scene.status, 'IGNITED');
  assert.equal(r1.scene.contents[0].key, 'a');
  refractoryState = r1.refractoryState;

  const r2 = compete(wm, 3, refractoryState);
  assert.equal(r2.scene.status, 'IGNITED');
  assert.equal(r2.scene.contents[0].key, 'a');
  refractoryState = r2.refractoryState;

  const r3 = compete(wm, 4, refractoryState);
  assert.equal(r3.scene.status, 'SUBTHRESHOLD');
  assert.equal(r3.scene.contents.length, 0);
});

test('CAPTURE_OVERRIDE bypasses refractory rule', () => {
  const wm = createMockWorkingMemory([{ key: 'a', activation: 0.95 }]);

  let refractoryState = { wins: [] };
  const r1 = compete(wm, 2, refractoryState);
  refractoryState = r1.refractoryState;
  const r2 = compete(wm, 3, refractoryState);
  refractoryState = r2.refractoryState;
  const r3 = compete(wm, 4, refractoryState);

  assert.equal(r3.scene.status, 'IGNITED');
  assert.equal(r3.scene.contents[0].key, 'a');
});

test('contested winners within MIN_MARGIN broadcast together within width', () => {
  const wm = createMockWorkingMemory([
    { key: 'a', activation: 0.8 },
    { key: 'b', activation: 0.78 },
  ]);

  const { scene } = compete(wm, 3);
  assert.equal(scene.status, 'IGNITED');
  assert.equal(scene.contents.length, 2);
  const keys = scene.contents.map((c) => c.key).sort();
  assert.deepEqual(keys, ['a', 'b']);
});

test('broadcasts only top winner when margin exceeds MIN_MARGIN', () => {
  const wm = createMockWorkingMemory([
    { key: 'a', activation: 0.9 },
    { key: 'b', activation: 0.6 },
  ]);

  const { scene } = compete(wm, 3);
  assert.equal(scene.status, 'IGNITED');
  assert.equal(scene.contents.length, 1);
  assert.equal(scene.contents[0].key, 'a');
});

test('sceneId is deterministic for same cycle and contents', () => {
  const wm = createMockWorkingMemory([
    { key: 'a', activation: 0.7 },
    { key: 'b', activation: 0.6 },
  ]);

  const r1 = compete(wm, 10);
  const r2 = compete(wm, 10);
  assert.equal(r1.scene.sceneId, r2.scene.sceneId);
  assert.ok(r1.scene.sceneId.startsWith('sc_'));
});

test('sceneId differs for different cycles', () => {
  const wm = createMockWorkingMemory([{ key: 'a', activation: 0.7 }]);

  const r1 = compete(wm, 10);
  const r2 = compete(wm, 11);
  assert.notEqual(r1.scene.sceneId, r2.scene.sceneId);
});

test('rejects enqueue, execute and approve proposal kinds', () => {
  const wm = createMockWorkingMemory([{ key: 'a', activation: 0.7 }]);
  const { scene } = compete(wm, 2);

  const specialists = [
    { name: 'bad', fn: () => [
      { kind: 'enqueue', target: 'a', payload: {} },
      { kind: 'execute', target: 'a', payload: {} },
      { kind: 'approve', target: 'a', payload: {} },
    ] },
  ];

  const result = broadcast(scene, specialists);
  assert.equal(result.proposals.length, 0);
  assert.equal(result.rejectedProposals.length, 3);
  assert.equal(result.rejectedProposals[0].reason, 'proposal_kind_not_allowed');
});

test('accepts allowed proposal kinds', () => {
  const wm = createMockWorkingMemory([{ key: 'a', activation: 0.7 }]);
  const { scene } = compete(wm, 2);

  const specialists = [
    { name: 'scheduler', fn: () => [
      { kind: 'annotate-urgency', target: 'a', payload: { urgency: 0.8 } },
    ] },
    { name: 'dream', fn: () => [
      { kind: 'focus-hypothesis', target: 'a', payload: { hypothesis: 'h1' } },
    ] },
  ];

  const result = broadcast(scene, specialists);
  assert.equal(result.proposals.length, 2);
  assert.equal(result.proposals[0].specialist, 'scheduler');
  assert.equal(result.proposals[0].authority, AUTHORITY.PROPOSAL_ONLY);
  assert.equal(result.proposals[1].specialist, 'dream');
});

test('caps proposals per scene', () => {
  const wm = createMockWorkingMemory([{ key: 'a', activation: 0.7 }]);
  const { scene } = compete(wm, 2);

  const proposals = [];
  for (let i = 0; i < 20; i++) {
    proposals.push({ kind: 'annotate-urgency', target: 'a', payload: { i } });
  }
  const specialists = [{ name: 'spammer', fn: () => proposals }];

  const result = broadcast(scene, specialists);
  assert.ok(result.proposals.length <= MAX_PROPOSALS_PER_SCENE);
});

test('authority is PROPOSAL_ONLY', () => {
  const wm = createMockWorkingMemory([{ key: 'a', activation: 0.7 }]);
  const { scene } = compete(wm, 2);
  assert.equal(scene.authority, AUTHORITY.PROPOSAL_ONLY);

  const specialists = [
    { name: 's', fn: () => [{ kind: 'annotate-urgency', target: 'a', payload: {} }] },
  ];
  const result = broadcast(scene, specialists);
  assert.equal(result.authority, AUTHORITY.PROPOSAL_ONLY);
  assert.equal(result.proposals[0].authority, AUTHORITY.PROPOSAL_ONLY);
});

test('broadcast does not run on SUBTHRESHOLD scene', () => {
  const wm = createMockWorkingMemory([{ key: 'a', activation: 0.3 }]);
  const { scene } = compete(wm, 2);
  assert.equal(scene.status, 'SUBTHRESHOLD');

  const specialists = [
    { name: 's', fn: () => [{ kind: 'annotate-urgency', target: 'a', payload: {} }] },
  ];
  const result = broadcast(scene, specialists);
  assert.equal(result.proposals.length, 0);
});

test('compete handles invalid working memory gracefully', () => {
  const { scene } = compete(null, 1);
  assert.equal(scene.status, 'SUBTHRESHOLD');
  assert.equal(scene.contents.length, 0);
});

test('broadcast handles invalid scene gracefully', () => {
  const result = broadcast(null, []);
  assert.equal(result.schemaVersion, SCHEMA_VERSION);
});

test('specialist errors do not break broadcast', () => {
  const wm = createMockWorkingMemory([{ key: 'a', activation: 0.7 }]);
  const { scene } = compete(wm, 2);

  const specialists = [
    { name: 'crasher', fn: () => { throw new Error('boom'); } },
    { name: 'good', fn: () => [{ kind: 'annotate-urgency', target: 'a', payload: {} }] },
  ];

  const result = broadcast(scene, specialists);
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].specialist, 'good');
});

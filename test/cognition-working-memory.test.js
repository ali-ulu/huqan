'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SCHEMA_VERSION, DEFAULT_CAPACITY, MAX_CAPACITY, DECAY_PER_CYCLE, REHEARSAL_BOOST, ACTIVATION_FLOOR, MAX_EVICTED_TRAIL,
  createWorkingMemory, resume, tick, admit, snapshot } = require('../lib/cognition/working-memory');

test('constants', () => {
  assert.equal(DEFAULT_CAPACITY, 5);
  assert.equal(MAX_CAPACITY, 9);
  assert.equal(DECAY_PER_CYCLE, 0.85);
  assert.equal(REHEARSAL_BOOST, 0.2);
  assert.equal(ACTIVATION_FLOOR, 0.05);
  assert.equal(MAX_EVICTED_TRAIL, 16);
});

test('never exceeds capacity and keeps goal pinned', () => {
  let s = createWorkingMemory({ capacity: 2, goal: { key: 'goal', text: 'fix', pinned: true } });
  s = admit(s, { key: 'a', salience: 0.9 }, 1);
  s = admit(s, { key: 'b', salience: 0.8 }, 2);
  s = admit(s, { key: 'c', salience: 0.7 }, 3);
  assert.equal(s.items.length, 2);
  assert.equal(s.goal.key, 'goal');
  assert.equal(s.goal.pinned, true);
});

test('evicts lowest activation with enteredAt then key tie-break', () => {
  let s = createWorkingMemory({ capacity: 2 });
  s = admit(s, { key: 'a', salience: 0.5 }, 1);
  s = admit(s, { key: 'b', salience: 0.5 }, 1);
  s = admit(s, { key: 'c', salience: 0.9 }, 2);
  // a and b tie at 0.5 enteredAt 1; key a evicted
  const keys = s.items.map(i => i.key).sort();
  assert.deepEqual(keys, ['b', 'c']);
  assert.equal(s.evicted[s.evicted.length-1].key, 'a');
  assert.equal(s.evicted[s.evicted.length-1].reason, 'capacity');
});

test('rehearsal raises activation up to 1', () => {
  let s = createWorkingMemory({ capacity: 5 });
  s = admit(s, { key: 'a', salience: 0.9 }, 1);
  const before = s.items[0].activation;
  s = admit(s, { key: 'a', salience: 0.9 }, 2);
  assert.equal(s.items[0].activation, Math.min(1, before + 0.2));
});

test('decay evicts below ACTIVATION_FLOOR', () => {
  let s = createWorkingMemory({ capacity: 5 });
  s = admit(s, { key: 'a', salience: 0.05 }, 1);
  s = tick(s, 2);
  assert.equal(s.items.length, 0);
  assert.equal(s.evicted[s.evicted.length-1].reason, 'decay');
});

test('refuses admission without salience', () => {
  let s = createWorkingMemory({ capacity: 5 });
  s = admit(s, { key: 'a', salience: null }, 1);
  assert.equal(s.items.length, 0);
  s = admit(s, { key: 'b' }, 1);
  assert.equal(s.items.length, 0);
});

test('returns new objects and does not mutate prior state', () => {
  const s0 = createWorkingMemory({ capacity: 5 });
  const s1 = admit(s0, { key: 'a', salience: 0.5 }, 1);
  assert.notEqual(s0, s1);
  assert.equal(s0.items.length, 0);
  assert.equal(s1.items.length, 1);
  const s2 = tick(s1, 2);
  assert.notEqual(s1, s2);
  assert.equal(s1.items[0].activation, 0.5);
});

test('resume with mismatched schema starts fresh with warning', () => {
  const r = resume({ schemaVersion: 'old', capacity: 9, items: [{ key: 'x', salience: 0.5, activation: 0.5, enteredAt: 1, lastRehearsedAt: 1 }] });
  assert.equal(r.state.items.length, 0);
  assert.equal(r.warning, 'schema_version_mismatch');
});

test('checkpoint round-trip preserves working memory', () => {
  let s = createWorkingMemory({ capacity: 3, goal: { key: 'g', text: 't', pinned: true } });
  s = admit(s, { key: 'a', perceptId: 'pc_1', salience: 0.7 }, 1);
  const snap = snapshot(s);
  const r = resume(snap);
  assert.equal(r.warning, null);
  assert.equal(r.state.items.length, 1);
  assert.equal(r.state.items[0].perceptId, 'pc_1');
  assert.equal(r.state.goal.key, 'g');
});

test('capacity clamps to [1,MAX_CAPACITY]', () => {
  assert.equal(createWorkingMemory({ capacity: 0 }).capacity, 1);
  assert.equal(createWorkingMemory({ capacity: 100 }).capacity, 9);
  assert.equal(createWorkingMemory({ capacity: 1.5 }).capacity, 5);
});

test('max evicted trail bounded', () => {
  let s = createWorkingMemory({ capacity: 1 });
  for (let i = 0; i < 20; i++) s = admit(s, { key: 'k' + i, salience: 0.5 }, i + 1);
  assert.ok(s.evicted.length <= 16);
});
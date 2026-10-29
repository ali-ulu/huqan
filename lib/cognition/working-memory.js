'use strict';

const { isPlainObject } = require('../is-plain-object');
const { AUTHORITY, freezeResult } = require('./contract');

const SCHEMA_VERSION = 'huqan-cognition-working-memory-v1';
const DEFAULT_CAPACITY = 5;
const MAX_CAPACITY = 9;
const DECAY_PER_CYCLE = 0.85;
const REHEARSAL_BOOST = 0.2;
const ACTIVATION_FLOOR = 0.05;
const MAX_EVICTED_TRAIL = 16;

function isText(value) { return typeof value === 'string' && value.trim() !== ''; }
function isInt(value) { return Number.isSafeInteger(value); }
function clampCapacity(value) {
  if (!isInt(value)) return DEFAULT_CAPACITY;
  return Math.min(MAX_CAPACITY, Math.max(1, value));
}
function clampCycle(value) {
  if (!isInt(value) || value < 0) return 0;
  return value;
}

function normalizeGoal(goal) {
  if (goal === null || goal === undefined) return null;
  if (!isPlainObject(goal)) return null;
  if (!isText(goal.key)) return null;
  return freezeResult({
    key: goal.key.trim(),
    text: typeof goal.text === 'string' ? goal.text : '',
    pinned: goal.pinned === true,
  });
}

function makeState({ capacity, cycle, goal, items, evicted } = {}) {
  const state = {
    schemaVersion: SCHEMA_VERSION,
    capacity: clampCapacity(capacity),
    cycle: clampCycle(cycle),
    goal: normalizeGoal(goal),
    items: Array.isArray(items) ? items.map((item) => freezeResult({
      key: item.key,
      perceptId: typeof item.perceptId === 'string' ? item.perceptId : null,
      activation: typeof item.activation === 'number' && Number.isFinite(item.activation) ? Math.min(1, Math.max(0, item.activation)) : 0,
      salience: (typeof item.salience === 'number' && Number.isFinite(item.salience)) ? item.salience : null,
      enteredAt: clampCycle(item.enteredAt),
      lastRehearsedAt: clampCycle(item.lastRehearsedAt),
    })) : [],
    evicted: Array.isArray(evicted) ? evicted.slice(-MAX_EVICTED_TRAIL).map((e) => freezeResult(e)) : [],
    authority: AUTHORITY.SIGNAL_ONLY,
  };
  return freezeResult(state);
}

function createWorkingMemory(input) {
  if (isPlainObject(input) && input.schemaVersion === SCHEMA_VERSION) {
    return makeState(input);
  }
  if (isPlainObject(input) && Object.hasOwn(input, 'schemaVersion') && input.schemaVersion !== SCHEMA_VERSION) {
    // resume mismatch: start fresh
    return makeState({});
  }
  const opts = isPlainObject(input) ? input : {};
  return makeState(opts);
}

function resume(saved) {
  if (!isPlainObject(saved)) return { state: makeState({}), warning: 'invalid_checkpoint' };
  if (saved.schemaVersion !== SCHEMA_VERSION) {
    return { state: makeState({}), warning: 'schema_version_mismatch' };
  }
  return { state: makeState(saved), warning: null };
}

function tick(state, cycle) {
  const base = isPlainObject(state) && state.schemaVersion === SCHEMA_VERSION ? state : makeState({});
  const nextCycle = cycle !== undefined ? clampCycle(cycle) : base.cycle + 1;
  const decayed = [];
  const evicted = [...(Array.isArray(base.evicted) ? base.evicted : [])];
  for (const item of (Array.isArray(base.items) ? base.items : [])) {
    const activation = item.activation * DECAY_PER_CYCLE;
    if (activation < ACTIVATION_FLOOR) {
      evicted.push(freezeResult({ key: item.key, reason: 'decay', cycle: nextCycle }));
    } else {
      decayed.push(freezeResult({ ...item, activation: Math.min(1, activation), lastRehearsedAt: item.lastRehearsedAt }));
    }
  }
  const trimmedEvicted = evicted.slice(-MAX_EVICTED_TRAIL);
  return makeState({ capacity: base.capacity, cycle: nextCycle, goal: base.goal, items: decayed, evicted: trimmedEvicted });
}

function admit(state, candidate, cycle) {
  const base = isPlainObject(state) && state.schemaVersion === SCHEMA_VERSION ? state : makeState({});
  if (!isPlainObject(candidate)) return base;
  if (!isText(candidate.key)) return base;
  const salience = (typeof candidate.salience === 'number' && Number.isFinite(candidate.salience)) ? candidate.salience : null;
  if (salience === null) return base; // refuses admission without salience
  const key = candidate.key.trim();
  const c = cycle !== undefined ? clampCycle(cycle) : base.cycle;
  const perceptId = typeof candidate.perceptId === 'string' ? candidate.perceptId : (candidate.perceptId ?? null);
  const items = [...(Array.isArray(base.items) ? base.items : [])];
  const idx = items.findIndex((it) => it.key === key);
  if (idx >= 0) {
    const existing = items[idx];
    const boosted = Math.min(1, existing.activation + REHEARSAL_BOOST);
    items[idx] = freezeResult({ ...existing, activation: boosted, salience, lastRehearsedAt: c });
  } else {
    items.push(freezeResult({ key, perceptId, activation: salience, salience, enteredAt: c, lastRehearsedAt: c }));
  }
  // capacity enforcement
  const capacity = base.capacity;
  if (items.length > capacity) {
    // evict lowest activation; tie-break enteredAt then key
    const sorted = items.map((it, i) => ({ it, i })).sort((a, b) => {
      if (a.it.activation !== b.it.activation) return a.it.activation - b.it.activation;
      if (a.it.enteredAt !== b.it.enteredAt) return a.it.enteredAt - b.it.enteredAt;
      return a.it.key < b.it.key ? -1 : a.it.key > b.it.key ? 1 : 0;
    });
    const evictIndex = sorted[0].i;
    const evictedItem = items[evictIndex];
    items.splice(evictIndex, 1);
    const evicted = [...(Array.isArray(base.evicted) ? base.evicted : []), freezeResult({ key: evictedItem.key, reason: 'capacity', cycle: c })].slice(-MAX_EVICTED_TRAIL);
    return makeState({ capacity: base.capacity, cycle: base.cycle, goal: base.goal, items, evicted });
  }
  return makeState({ capacity: base.capacity, cycle: base.cycle, goal: base.goal, items, evicted: base.evicted });
}

function snapshot(state) {
  const base = isPlainObject(state) && state.schemaVersion === SCHEMA_VERSION ? state : makeState({});
  return freezeResult(JSON.parse(JSON.stringify(base)));
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULT_CAPACITY,
  MAX_CAPACITY,
  DECAY_PER_CYCLE,
  REHEARSAL_BOOST,
  ACTIVATION_FLOOR,
  MAX_EVICTED_TRAIL,
  createWorkingMemory,
  resume,
  tick,
  admit,
  snapshot,
};
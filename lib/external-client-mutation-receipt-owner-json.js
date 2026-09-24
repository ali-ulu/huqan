'use strict';

// #2149: deterministic JSON copying and the exact-shape guards used on
// every untrusted input; each failure carries an owner error code.

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = Object.freeze({ ...details });
  throw error;
}

const { isPlainObject } = require('./is-plain-object');

function copyDeterministicJson(value, state = {
  depth: 0,
  budget: { nodes: 0 },
  seen: new WeakSet(),
}) {
  state.budget.nodes += 1;
  if (state.budget.nodes > 10000) {
    throw new TypeError('JSON structure is unbounded or circular');
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JSON number must be finite');
    return value;
  }
  if (!value || typeof value !== 'object') throw new TypeError('value is not JSON data');
  if (state.depth >= 32 || state.seen.has(value)) {
    throw new TypeError('JSON structure is unbounded or circular');
  }

  const array = Array.isArray(value);
  if (!array && !isPlainObject(value)) throw new TypeError('JSON object must be plain');
  const keys = Reflect.ownKeys(value);
  const output = array ? [] : {};
  state.seen.add(value);
  try {
    if (array) {
      if (keys.length !== value.length + 1 || keys.some((key) => {
        if (key === 'length') return false;
        if (typeof key !== 'string') return true;
        const index = Number(key);
        return !Number.isInteger(index) || index < 0 || index >= value.length
          || String(index) !== key;
      })) {
        throw new TypeError('JSON array must be dense and unextended');
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
          throw new TypeError('JSON array entry must be an enumerable data property');
        }
        output.push(copyDeterministicJson(descriptor.value, {
          ...state,
          depth: state.depth + 1,
        }));
      }
      return output;
    }

    for (const key of keys) {
      if (typeof key !== 'string' || key === '__proto__') {
        throw new TypeError('JSON object key is unsupported');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('JSON object entry must be an enumerable data property');
      }
      output[key] = copyDeterministicJson(descriptor.value, {
        ...state,
        depth: state.depth + 1,
      });
    }
    return output;
  } finally {
    state.seen.delete(value);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function snapshotJson(value, code, message) {
  try {
    return deepFreeze(copyDeterministicJson(value));
  } catch (_) {
    fail(code, message);
  }
}

function assertExactKeys(value, allowed, code, message) {
  if (!isPlainObject(value)) fail(code, message);
  const allowedSet = new Set(allowed);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== allowed.length || keys.some((key) => (
    typeof key !== 'string' || !allowedSet.has(key)
  ))) {
    fail(code, message);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail(code, message, { field: key });
    }
  }
}

function assertAllowedKeys(value, allowed, code, message) {
  if (!isPlainObject(value)) fail(code, message);
  const allowedSet = new Set(allowed);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === 'string'
      ? Object.getOwnPropertyDescriptor(value, key)
      : null;
    if (typeof key !== 'string' || !allowedSet.has(key)
      || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail(code, message, { field: typeof key === 'string' ? key : 'symbol' });
    }
  }
}

function text(value, code, message, details = {}) {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value) {
    fail(code, message, details);
  }
  return value;
}

function canonicalInstant(value, code, message, details = {}) {
  const normalized = text(value, code, message, details);
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== normalized) {
    fail(code, message, details);
  }
  return normalized;
}

module.exports = {
  assertAllowedKeys,
  assertExactKeys,
  canonicalInstant,
  deepFreeze,
  fail,
  isPlainObject,
  snapshotJson,
  text,
};

'use strict';

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function copyDeterministicJson(value, ancestors = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JSON numbers must be finite');
    return value;
  }
  if (!value || typeof value !== 'object') throw new TypeError('value is not JSON data');
  if (ancestors.has(value)) throw new TypeError('circular JSON data');

  const isArray = Array.isArray(value);
  if (!isArray && !plain(value)) throw new TypeError('JSON objects must be plain');
  const keys = Reflect.ownKeys(value);
  const result = isArray ? [] : {};
  ancestors.add(value);
  try {
    if (isArray) {
      if (keys.length !== value.length + 1 || keys.some((key) => {
        if (key === 'length') return false;
        if (typeof key !== 'string') return true;
        const index = Number(key);
        return !Number.isInteger(index) || index < 0 || index >= value.length
          || String(index) !== key;
      })) throw new TypeError('JSON arrays must be dense and unextended');
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
            || !descriptor.enumerable) {
          throw new TypeError('JSON array entries must be enumerable data properties');
        }
        result.push(copyDeterministicJson(descriptor.value, ancestors));
      }
      return result;
    }

    for (const key of keys) {
      if (typeof key !== 'string' || key === '__proto__') {
        throw new TypeError('JSON object key is not canonically serializable');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || !descriptor.enumerable) {
        throw new TypeError('JSON object entries must be enumerable data properties');
      }
      result[key] = copyDeterministicJson(descriptor.value, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

module.exports = { copyDeterministicJson };

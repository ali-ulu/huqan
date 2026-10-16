'use strict';

const { types } = require('node:util');

function dataRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && !types.isProxy(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).every(key => typeof key === 'string'
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}

function boundedProcedureData(value, seen = new Set(), budget = { left: 1024 }, depth = 0) {
  if (--budget.left < 0 || depth > 16) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= 32768;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object' || types.isProxy(value) || seen.has(value)) return false;
  if (!Array.isArray(value) && !dataRecord(value)) return false;
  if (Array.isArray(value) && (Object.getPrototypeOf(value) !== Array.prototype || value.length > 1024
    || Reflect.ownKeys(value).length !== value.length + 1)) return false;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !Object.hasOwn(descriptor, 'value')
      || !boundedProcedureData(descriptor.value, seen, budget, depth + 1)) return false;
  }
  seen.delete(value);
  return true;
}

module.exports = { dataRecord, boundedProcedureData };

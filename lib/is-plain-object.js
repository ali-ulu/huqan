'use strict';

/**
 * True only for ordinary records: objects created with Object.prototype or a
 * null prototype. Predicate callers use this at trust and admission
 * boundaries, so proxy failures are rejected rather than treated as records.
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  try {
    if (Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch (_) {
    return false;
  }
}

module.exports = { isPlainObject };

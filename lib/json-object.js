'use strict';

/**
 * Parse a value that may already be an object, may be a JSON string, or may be
 * neither, into a plain object.
 *
 * Arrays are treated as "not an object" on both the input and the parsed
 * result: the callers here read `policy_json` / `context_json` columns whose
 * contract is a keyed record, and silently accepting an array would hand them
 * a shape their property access cannot work with.
 *
 * Never throws -- an unparseable value yields the caller's fallback.
 */
function parseJsonObject(value, fallback = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

module.exports = { parseJsonObject };

'use strict';

/**
 * Canonical JSON-safe deep clone used at trust and admission boundaries.
 *
 * `undefined`/`null` pass through so the ""absent stays absent"" contract the
 * eleven local `clone(value)` helpers encoded is preserved in one place.
 * Non-serializable input throws the same TypeError JSON.stringify throws --
 * this helper never silently converts unserializable input to a string.
 */
function cloneJson(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

module.exports = { cloneJson };

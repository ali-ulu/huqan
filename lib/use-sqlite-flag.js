'use strict';

/**
 * The one place that reads a `useSQLite` value, so "ask for SQLite" means the
 * same thing everywhere it is configured.
 *
 * The value reaches the runtime as a caller/config input, not necessarily a
 * boolean: `USE_SQLITE` in the environment, an option object, or a persisted
 * record. Before this module, `useSQLite !== true` in the SQLite writer meant a
 * truthy `'1'`/`1` silently dropped to the ephemeral memory backend while the
 * same value with no driver threw -- one input, two outcomes (#4559). The
 * kernel factory and MemoryStore both normalize here now, so an env opt-in and
 * a direct option cannot disagree.
 *
 * Lives in the Core ring: it is a pure domain rule (no fs, no driver, no
 * process state), so the Core kernel factory may depend on it without reaching
 * into the Adapters persistence family.
 *
 * `undefined`/`null` stays `undefined` -- the default backend -- while every
 * other unrecognized value is refused instead of guessed.
 */

const USE_SQLITE_TRUE = new Set([true, 1, '1', 'true']);
const USE_SQLITE_FALSE = new Set([false, 0, '0', 'false']);

function normalizeUseSQLiteFlag(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const token = value.trim().toLowerCase();
    if (USE_SQLITE_TRUE.has(token)) return true;
    if (USE_SQLITE_FALSE.has(token)) return false;
    throw invalidUseSQLite(value);
  }
  if (USE_SQLITE_TRUE.has(value)) return true;
  if (USE_SQLITE_FALSE.has(value)) return false;
  throw invalidUseSQLite(value);
}

function invalidUseSQLite(value) {
  const error = new TypeError(`invalid useSQLite value: ${JSON.stringify(value)}; expected a boolean, 0/1 or 'true'/'false'`);
  error.code = 'HUQAN_INVALID_USE_SQLITE';
  return error;
}

module.exports = {
  normalizeUseSQLiteFlag,
};

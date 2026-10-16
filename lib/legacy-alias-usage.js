'use strict';

/**
 * How often the AXIOM-era spellings are still being used.
 *
 * RFC-001 decision 7 set the shape of the migration -- a reader accepts both
 * spellings, a writer emits only the canonical one -- and both choke points
 * exist and are enforced: `canonicalMcpToolName` for `axiom.*` tool names, and
 * `readCompatibleEnvironmentVariable` for `AXIOM_*` variables, the latter
 * guarded by lib/environment-compat-bypass.test.js.
 *
 * What was missing is the denominator. Nothing counted, so "is it going down?"
 * had no answer, and a deprecation without one never completes: there is never
 * a moment where removing the alias is evidently safe, so it is never removed
 * and the compatibility window quietly becomes permanent.
 *
 * Scope, deliberately small:
 *
 * - Process-local and in-memory. This is a local-first product; a counter that
 *   needed a database would not survive the first deployment that does not run
 *   one, and would answer a question nobody asked.
 * - Counted where the alias is *resolved*, not where the name is parsed, so
 *   documentation tooling and tests that merely mention `axiom.learn` do not
 *   inflate the number. Only a call that actually took the legacy path counts.
 * - Never throws and never blocks. A metric that can fail the request it
 *   measures is a worse bug than the one it is measuring.
 */

const counts = new Map();

function key(kind, name) {
  return `${kind}:${name}`;
}

/**
 * Record one resolution of a legacy identifier.
 *
 * @param {'mcp_tool'|'environment'} kind which surface resolved it
 * @param {string} name the legacy spelling that was used
 */
function recordLegacyAliasUse(kind, name) {
  // Both must be non-empty: an empty kind would file counts under a surface
  // that does not exist, and read back as a category nobody can act on.
  if (typeof kind !== 'string' || !kind || typeof name !== 'string' || !name) return;
  const id = key(kind, name);
  counts.set(id, (counts.get(id) || 0) + 1);
}

/**
 * A snapshot of what has been resolved in this process.
 *
 * The breakdown objects are null-prototype: `name` reaches this from an
 * exported function, and a legacy identifier spelled `__proto__` must land as
 * an ordinary key rather than reaching Object.prototype. Spread them before
 * comparing against a plain object literal.
 *
 * @returns {{total: number, byKind: Record<string, number>, byName: Record<string, number>}}
 */
function legacyAliasUsage() {
  const byKind = Object.create(null);
  const byName = Object.create(null);
  let total = 0;
  for (const [id, count] of counts) {
    const separator = id.indexOf(':');
    const kind = id.slice(0, separator);
    const name = id.slice(separator + 1);
    byKind[kind] = (byKind[kind] || 0) + count;
    byName[name] = (byName[name] || 0) + count;
    total += count;
  }
  return { total, byKind, byName };
}

/** Reset the snapshot. For tests, and for a caller sampling an interval. */
function resetLegacyAliasUsage() {
  counts.clear();
}

module.exports = {
  recordLegacyAliasUse,
  legacyAliasUsage,
  resetLegacyAliasUsage,
};

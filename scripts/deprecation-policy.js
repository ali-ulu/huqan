/**
 * Deprecation contract for this package (issue #2649, task M4).
 *
 * This module is the single vocabulary for "X is old": what counts as a
 * deprecation record, what a compliant record must carry, and when the clock
 * runs out. Prose JSDoc alone drifts -- `KernelV1` is already exported with an
 * English sentence and no version, so no machine can say when its time runs
 * out. The checker in scripts/check-deprecations.js turns these records into
 * findings; this file only owns the definitions.
 *
 * The contract: a deprecation names what is old (name and kind), the release
 * that retires it from the default (deprecatedIn), the release by which the
 * removal must have shipped (removalIn), and where the replacement is
 * documented (migrationPath).
 */

'use strict';

const MAJOR = 0;
const MINOR = 1;
const PATCH = 2;

const KINDS = Object.freeze(['export', 'cli', 'mcp-tool', 'route', 'config']);

function parseSemver(version) {
  const match = /^\s*(\d+)\.(\d+)\.(\d+)(?:[-+].*)?\s*$/.exec(String(version || ''));
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareTriples(left, right) {
  for (const slot of [MAJOR, MINOR, PATCH]) {
    if (left[slot] !== right[slot]) return left[slot] < right[slot] ? -1 : 1;
  }
  return 0;
}

function recordViolations(record) {
  const problems = [];
  const item = (record && record.name) || '(unnamed)';
  if (!record || typeof record !== 'object') return [`${item}: not a deprecation record`];
  if (!record.name) problems.push(`${item}: missing "name"`);
  if (!KINDS.includes(record.kind)) problems.push(`${item}: unknown kind`);
  if (!parseSemver(record.deprecatedIn)) problems.push(`${item}: deprecatedIn is not a release`);
  if (!parseSemver(record.removalIn)) problems.push(`${item}: removalIn is not a release`);
  if (!record.migrationPath) problems.push(`${item}: missing migrationPath`);
  return problems;
}

// A minor line may carry a deprecation for at least one full minor (the tag
// in deprecatedIn must be reachable from the current release), and removal is
// only a finding when the current release has reached or passed removalIn. A
// removal version whose major equals the current major is always early -- the
// issue calls it "Removed in X+1.0", so removal waits for the next major.

function windowViolations(record, currentVersion) {
  const problems = [];
  const item = (record && record.name) || '(unnamed)';
  const deprecated = parseSemver(record && record.deprecatedIn);
  const removed = parseSemver(record && record.removalIn);
  const current = parseSemver(currentVersion);
  if (!deprecated || !removed || !current) return problems;
  if (compareTriples(removed, deprecated) <= 0) {
    problems.push(`${item}: removalIn must be after deprecatedIn`);
  }
  if (compareTriples(current, removed) < 0) return problems;
  problems.push(`${item}: removalIn ${record.removalIn} reached at ${currentVersion}, remove it`);
  return problems;
}

module.exports = { KINDS, parseSemver, compareTriples, recordViolations, windowViolations };

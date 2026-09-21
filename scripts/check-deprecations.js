/**
 * Deprecation enforcement (issue #2649, task M4).
 *
 * Reads the deprecation registry, verifies each record against the policy in
 * lib/deprecation-policy.js (completeness, version windows), checks that the
 * runtime actually warns and the migration guide exists, and fails the run on
 * any violation. Every check below is a different face of one promise: a
 * consumer reading the deprecation notice gets a true version, a real warning
 * and a working guide, and a maintained feature never trips the gate.
 *
 * Usage:  node scripts/check-deprecations.js
 * Exit 0 = every deprecation is complete, on schedule, warned and guided.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { KINDS, parseSemver, recordViolations, windowViolations } = require('./deprecation-policy');

const repoRoot = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(repoRoot, 'deprecations.json');

const WARNING_CALL = /(?:process\.emitWarning|console\.warn)\s*\(/;
const GUIDE_VERDICTS = Object.freeze({ found: 'found', missing: 'missing' });

function readRegistry(registryPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error(`${registryPath} must hold an array of deprecation records`);
    return parsed;
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}

function packageVersion(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
}

// A warned feature is one whose implementation file calls a warning API. The
// scan reads text, not reachability: a warning that exists but never fires is
// a better failure mode than a checker that claims proof of execution, and
// proving execution belongs to a test, not to a file grep.

function findWarningCall(searchRoots) {
  for (const root of searchRoots) {
    const full = path.join(repoRoot, root);
    let source;
    try {
      source = fs.readFileSync(full, 'utf8');
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'EISDIR')) continue;
      throw error;
    }
    if (WARNING_CALL.test(source)) return root;
  }
  return null;
}

function guideVerdict(record) {
  if (!record || !record.migrationPath) return GUIDE_VERDICTS.missing;
  return fs.existsSync(path.join(repoRoot, record.migrationPath))
    ? GUIDE_VERDICTS.found
    : GUIDE_VERDICTS.missing;
}

function collectViolations(records, currentVersion) {
  const violations = [];
  for (const record of records) {
    const item = (record && record.name) || '(unnamed)';
    violations.push(...recordViolations(record));
    violations.push(...windowViolations(record, currentVersion));
    if (record && KINDS.includes(record.kind) && parseSemver(record.deprecatedIn) && parseSemver(record.removalIn)) {
      const warned = findWarningCall(record.warnedIn || []);
      if (!warned) violations.push(`${item}: no runtime warning found in [${(record.warnedIn || []).join(', ')}]`);
      if (guideVerdict(record) === GUIDE_VERDICTS.missing) {
        violations.push(`${item}: migration guide missing at ${record.migrationPath}`);
      }
    }
  }
  return violations;
}

function main() {
  const records = readRegistry(REGISTRY_PATH);
  const violations = collectViolations(records, packageVersion(repoRoot));
  if (violations.length === 0) {
    console.log(`deprecations OK: ${records.length} recorded, all complete, on schedule, warned and guided.`);
    return 0;
  }
  console.error(`FAIL: ${violations.length} deprecation violation(s):\n`);
  for (const violation of violations) console.error(`  - ${violation}`);
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = { readRegistry, packageVersion, findWarningCall, guideVerdict, collectViolations, GUIDE_VERDICTS };

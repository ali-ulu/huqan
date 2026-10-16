'use strict';

// Shared state and helpers for the external conformance consumer: every
// consumer-*.js section records into the same case list, and finish() reports it.

const fs = require('node:fs');
const path = require('node:path');

const PKG_ROOT = path.dirname(require.resolve('huqan/package.json'));
const LEGACY_SPEC_ROOT = path.join(PKG_ROOT, 'specs', 'axiom-trust-protocol', '0.1');
const CANONICAL_SPEC_ROOT = path.join(PKG_ROOT, 'specs', 'huqan-trust-protocol', '0.2');
const LEGACY_PACKAGE_ROOT = path.join(PKG_ROOT, 'specs', 'axiom-package-format', '0.1');
const CANONICAL_PACKAGE_ROOT = path.join(PKG_ROOT, 'specs', 'huqan-package-format', '0.2');
const SPEC_ROOT = LEGACY_SPEC_ROOT;
const EXAMPLES = path.join(SPEC_ROOT, 'examples');

const EVIDENCE_LEVELS = Object.freeze({
  surface: 'packaged-surface-smoke',
  objects: 'self-test',
  'fail-closed': 'self-test',
  bundles: 'self-test',
  'package-wire': 'installed-package-self-test',
  replay: 'self-test',
  v5: 'self-test',
  'cross-implementation': 'cross-implementation-conformance',
});

const cases = [];
const pendingCases = [];

function record(group, name, status, detail = '') {
  cases.push({
    group,
    name,
    status,
    ok: status === 'pass',
    evidenceLevel: EVIDENCE_LEVELS[group],
    detail,
  });
}

function skipped(detail) {
  return { skipped: true, detail };
}

function check(group, name, fn) {
  try {
    const result = fn();
    if (result && result.skipped === true) {
      record(group, name, 'skip', result.detail || '');
    } else {
      record(group, name, 'pass', result || '');
    }
  } catch (error) {
    record(group, name, 'fail', error && error.message ? error.message : String(error));
  }
}

function checkAsync(group, name, fn) {
  pendingCases.push(Promise.resolve().then(fn).then(
    (result) => record(group, name, 'pass', result || ''),
    (error) => record(group, name, 'fail', error && error.message ? error.message : String(error)),
  ));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function finish() {
  await Promise.all(pendingCases);
  const failed = cases.filter((c) => c.status === 'fail');
  const skippedCases = cases.filter((c) => c.status === 'skip');
  const crossImplementationCase = cases.find((c) => c.group === 'cross-implementation');
  const report = {
    evidenceLevels: EVIDENCE_LEVELS,
    evidenceLevelNote:
      'Evidence is group-scoped: package reachability is a packaged-surface smoke; '
      + 'ATP object, package-wire, replay, and JavaScript bundle checks are self-test; the Python comparison is '
      + 'cross-implementation conformance only when its case passes. '
      + 'This run does not establish third-party verification or interoperability.',
    crossImplementationExecuted: crossImplementationCase?.status === 'pass',
    packageRoot: PKG_ROOT,
    packageVersion: readJson(path.join(PKG_ROOT, 'package.json')).version,
    total: cases.length,
    passed: cases.length - failed.length - skippedCases.length,
    skipped: skippedCases.length,
    failed: failed.length,
    blockedGaps: [],
    cases,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

module.exports = {
  PKG_ROOT,
  LEGACY_SPEC_ROOT,
  CANONICAL_SPEC_ROOT,
  LEGACY_PACKAGE_ROOT,
  CANONICAL_PACKAGE_ROOT,
  SPEC_ROOT,
  EXAMPLES,
  record,
  skipped,
  check,
  checkAsync,
  assert,
  readJson,
  finish,
};

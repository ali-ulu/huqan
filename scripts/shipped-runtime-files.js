#!/usr/bin/env node
'use strict';

/**
 * The one definition of "shipped runtime files" for gates that must check the
 * runtime but not this repository's own dev/CI tooling.
 *
 * Several gates scan `git ls-files '*.js'`. Most legitimately cover scripts/ --
 * file size, control characters and import cycles apply to tooling too. But a
 * gate that protects a *runtime* invariant must not fail on a CI script: a
 * script is not in the deployed artifact and has no runtime behaviour to
 * protect. The env-compat bypass test is the canonical case -- it forbids
 * reading HUQAN_/AXIOM_ variables straight off `process.env`, yet
 * `scripts/check-module-boundary.js` carries a test-only
 * HUQAN_CONTEXT_OWNERSHIP hook that is not runtime code (#3262 -> #3278).
 *
 * The boundary is `package.json` `files`: what npm actually ships. A scripts/
 * file that is shipped stays in scope; the rest of scripts/ is dev/CI tooling
 * (#2402, where the reachability graph drops scripts/ for the same reason).
 *
 * Keep this module dependency-free (node builtins and package.json only): it is
 * required from a test, so anything it pulls in joins that test's selection
 * closure.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

/** Files npm would publish, per package.json `files`. */
function shippedFiles(root = REPO_ROOT) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return new Set(pkg.files || []);
}

/** A scripts/ file is dev/CI tooling unless npm ships it. */
function isNonRuntimeTooling(relPath, shipped = shippedFiles()) {
  return relPath.startsWith('scripts/') && !shipped.has(relPath);
}

const EXCLUDE = /(^|\/)(node_modules|graphify-out)\//;
const IS_TEST = /(\.test\.js$|(^|\/)test\/|(^|\/)benchmarks\/|(^|\/)demo)/;

/**
 * Git-tracked .js files that belong to the shipped runtime: tests, benchmarks,
 * demos, vendored trees and non-shipped scripts removed.
 *
 * @param {object} [opts]
 * @param {string} [opts.root] repository root
 * @returns {string[]} repo-relative, forward-slashed paths
 */
function listRuntimeFiles({ root = REPO_ROOT } = {}) {
  const shipped = shippedFiles(root);
  const out = execFileSync('git', ['ls-files', '*.js'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\n')
    .map((line) => line.trim().replace(/\\/g, '/'))
    .filter(Boolean)
    .filter((file) => !EXCLUDE.test(file))
    .filter((file) => !IS_TEST.test(file))
    .filter((file) => !isNonRuntimeTooling(file, shipped));
}

module.exports = {
  REPO_ROOT,
  EXCLUDE,
  IS_TEST,
  shippedFiles,
  isNonRuntimeTooling,
  listRuntimeFiles,
};

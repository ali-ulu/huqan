#!/usr/bin/env node
'use strict';

/**
 * Fail when a module reaches into another object's `_private` member
 * (docs/architecture-policy.md §4).
 *
 * This is the defect that made every previous refactor break something
 * unrelated. `agent.v3.js` calls `baseAgent._executeStepWithRetry()`,
 * `kernel.v2.js` calls `kernel._evaluateLearnAdmission()`, `lib/verify.js`
 * calls `kernel._verifyInternal()`. Those methods are the real contract
 * between the modules, but they are marked `_` -- so they have no
 * documentation, no direct test, and no stability promise. Changing one
 * breaks a caller the author had no reason to look at.
 *
 * `this._foo()` is not a violation: a module may use its own internals.
 * Only a call through another binding counts.
 *
 * Like scripts/check-file-size.js this is a ratchet, not a flat ban: 131
 * such calls exist today and a gate that cannot pass gets disabled. The
 * per-file count may fall and may not rise, and a file that reaches zero is
 * removed from the baseline so the gain cannot be spent later.
 *
 * Usage:  node scripts/check-module-boundary.js [--update]
 * Exit 0 = within budget, exit 1 = a violation.
 */

const fs = require('fs');
const path = require('path');
const { listSourceFiles, stripComments } = require('./check-import-cycles.js');

const repoRoot = path.resolve(__dirname, '..');
const BASELINE_PATH = path.join(__dirname, 'module-boundary-baseline.json');
const IS_TEST = /(\.test\.js$|(^|\/)test\/|(^|\/)benchmarks\/|(^|\/)demo)/;

// `owner._member(` where owner is a plain identifier or `this.field`. `this`
// itself is excluded -- a module owns its own internals -- as are the module
// system's own underscore-free namespaces.
const CALL = /\b(?:this\.(\w+)|(\w+))\.(_[A-Za-z]\w*)\s*\(/g;
const NOT_AN_OWNER = new Set(['this', 'module', 'exports', 'globalThis', 'process']);

function violationsIn(file) {
  const source = stripComments(fs.readFileSync(path.join(repoRoot, file), 'utf8'));
  const found = [];
  for (const match of source.matchAll(CALL)) {
    const owner = match[1] || match[2];
    if (!owner || NOT_AN_OWNER.has(owner)) continue;
    found.push({
      line: source.slice(0, match.index).split('\n').length,
      call: `${owner}.${match[3]}()`,
    });
  }
  return found;
}

function measure() {
  const counts = new Map();
  const detail = new Map();
  for (const file of listSourceFiles().filter((f) => !IS_TEST.test(f))) {
    const found = violationsIn(file);
    if (found.length > 0) {
      counts.set(file, found.length);
      detail.set(file, found);
    }
  }
  return { counts, detail };
}

function readBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return {};
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')).files || {};
}

function writeBaseline(counts) {
  const previous = readBaseline();
  const files = {};
  for (const file of [...counts.keys()].sort()) {
    const recorded = previous[file];
    // Never raise a recorded ceiling: --update locks in gains only.
    const ceiling = recorded ? Math.min(recorded.calls, counts.get(file)) : counts.get(file);
    files[file] = {
      calls: ceiling,
      why: (recorded && recorded.why) || 'Pre-existing debt recorded when the gate was introduced.',
      review_by: (recorded && recorded.review_by) || '2026-12-31',
    };
  }
  fs.writeFileSync(
    BASELINE_PATH,
    JSON.stringify({ threshold: 0, files }, null, 2) + '\n',
    'utf8',
  );
}

function main() {
  const update = process.argv.includes('--update');
  const { counts, detail } = measure();

  if (update) {
    writeBaseline(counts);
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    console.log(`Baseline written: ${counts.size} files, ${total} calls.`);
    return 0;
  }

  const baseline = readBaseline();
  const grew = [];
  const added = [];
  const shrank = [];

  for (const [file, count] of counts) {
    const recorded = baseline[file];
    if (!recorded) added.push({ file, count, detail: detail.get(file) });
    else if (count > recorded.calls) grew.push({ file, count, was: recorded.calls });
    else if (count < recorded.calls) shrank.push({ file, count, was: recorded.calls });
  }
  const cleared = Object.keys(baseline).filter((file) => !counts.has(file));
  const expired = Object.entries(baseline)
    .filter(([file, entry]) => counts.has(file) && entry.review_by < new Date().toISOString().slice(0, 10));

  const problems = grew.length + added.length + shrank.length + cleared.length + expired.length;
  if (problems === 0) {
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    console.log(`OK: ${total} recorded cross-module private calls in ${counts.size} files, none added.`);
    return 0;
  }

  for (const { file, count, detail: hits } of added) {
    console.error(`FAIL new: ${file} makes ${count} cross-module private call(s).`);
    for (const hit of hits.slice(0, 5)) console.error(`    ${file}:${hit.line}  ${hit.call}`);
  }
  for (const { file, count, was } of grew) {
    console.error(`FAIL grew: ${file} ${was} -> ${count} cross-module private call(s).`);
  }
  for (const { file, count, was } of shrank) {
    console.error(`FAIL stale: ${file} improved ${was} -> ${count}; run --update to lock the gain in.`);
  }
  for (const file of cleared) {
    console.error(`FAIL stale: ${file} has none left; run --update to drop its entry.`);
  }
  for (const [file, entry] of expired) {
    console.error(`FAIL expired: ${file} was due for review by ${entry.review_by} and still has debt.`);
  }
  console.error(
    '\nCall the other module through its public surface. If the member is'
    + '\nreally part of the contract, rename it without the underscore and'
    + '\ngive it a test; if it is not, do not call it from here.',
  );
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = { measure, violationsIn };

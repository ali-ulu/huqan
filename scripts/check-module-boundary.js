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
 * Like scripts/check-file-size.js this is a ratchet, not a flat ban: 110
 * such calls exist today and a gate that cannot pass gets disabled. The
 * per-file count may fall and may not rise, and a file that reaches zero is
 * removed from the baseline so the gain cannot be spent later.
 *
 * Usage:  node scripts/check-module-boundary.js [--update]
 * Exit 0 = within budget, exit 1 = a violation.
 */

const fs = require('fs');
const path = require('path');
const { listSourceFiles, stripComments, buildGraph } = require('./check-import-cycles.js');

const repoRoot = path.resolve(__dirname, '..');
const BASELINE_PATH = path.join(__dirname, 'module-boundary-baseline.json');
const OWNERSHIP_PATH = path.join(__dirname, 'context-ownership.json');
const IS_TEST = /(\.test\.js$|(^|\/)test\/|(^|\/)benchmarks\/|(^|\/)demo)/;

// `owner._member(` where owner is a plain identifier or `this.field`. `this`
// itself is excluded -- a module owns its own internals -- as are the module
// system's own underscore-free namespaces.
const CALL = /\b(?:this\.(\w+)|(\w+))\.(_[A-Za-z]\w*)\s*\(/g;
const NOT_AN_OWNER = new Set(['this', 'module', 'exports', 'globalThis', 'process']);

/**
 * `const store = this;` then `store._withTransaction()` is a module using its
 * own internals through an alias, which is what a closure built inside a
 * method has to do. Counting those as boundary crossings put 21 false
 * positives into `lib/memory-store.js` alone.
 *
 * Collected per file rather than per scope: an alias name is treated as
 * `this` everywhere in the file. The trade is a false negative if one file
 * binds `const store = this` in one place and a foreign `store` in another.
 * That is rarer than the false positive it removes, and the alternative is
 * parsing scopes -- which means a parser, which means a dependency.
 */
const THIS_ALIAS = /\b(?:const|let|var)\s+(\w+)\s*=\s*this\s*;/g;

function violationsIn(file) {
  const source = stripComments(fs.readFileSync(path.join(repoRoot, file), 'utf8'));
  const aliases = new Set([...source.matchAll(THIS_ALIAS)].map((match) => match[1]));
  const found = [];
  for (const match of source.matchAll(CALL)) {
    const owner = match[1] || match[2];
    if (!owner || NOT_AN_OWNER.has(owner) || aliases.has(owner)) continue;
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

/**
 * Context ownership (#2446 Enforce). The map lives in context-ownership.json,
 * generated from docs/architecture/ownership-map-2446.md; directory entries
 * exist only where the map names that directory with evidence, never inferred
 * from the directory name.
 *
 * Deliberate limit, stated so nobody over-reads the gate: a violation records
 * the caller's file and the `owner._member()` text, not the callee's file --
 * the owner binding cannot be resolved to a file without parsing scopes. The
 * gate therefore names the CALLER's context and refuses to guess the callee's.
 */
function loadOwnership(ownershipPath = OWNERSHIP_PATH) {
  const raw = JSON.parse(fs.readFileSync(ownershipPath, 'utf8'));
  const contexts = new Set(Array.isArray(raw.contexts) ? raw.contexts : []);
  const owners = raw.owners && typeof raw.owners === 'object' ? raw.owners : {};
  for (const [entryPath, entry] of Object.entries(owners)) {
    if (!entry || !contexts.has(entry.context)) {
      throw new Error(`context-ownership.json: unknown context for ${entryPath}`);
    }
  }
  const unassigned = raw.unassigned && typeof raw.unassigned === 'object' ? raw.unassigned : {};
  const publishedPorts = raw.publishedPorts || {};
  const legacyEdges = raw.legacyEdges || {};
  for (const [port, rule] of Object.entries(publishedPorts)) {
    if (ownerOf(port, { owners, unassigned }).context !== rule.owner
      || !Array.isArray(rule.consumers)
      || rule.consumers.some((context) => !contexts.has(context))
      || typeof rule.evidence !== 'string' || !rule.evidence) {
      throw new Error(`context-ownership.json: invalid published port ${port}`);
    }
  }
  for (const [edge, rule] of Object.entries(legacyEdges)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rule.reviewBy || '')
      || Number.isNaN(Date.parse(rule.reviewBy)) || !rule.reason) {
      throw new Error(`context-ownership.json: invalid legacy edge ${edge}`);
    }
  }
  return { contexts, owners, unassigned, publishedPorts, legacyEdges };
}

function ownerOf(file, ownership) {
  if (Object.hasOwn(ownership.owners, file)) {
    return { context: ownership.owners[file].context, status: ownership.owners[file].status || 'assigned' };
  }
  let best = null;
  for (const entryPath of Object.keys(ownership.owners)) {
    if (entryPath.endsWith('/') && file.startsWith(entryPath)) {
      if (!best || entryPath.length > best.length) best = entryPath;
    }
  }
  if (best) {
    return { context: ownership.owners[best].context, status: ownership.owners[best].status || 'assigned' };
  }
  if (Object.hasOwn(ownership.unassigned, file)) {
    return { context: null, status: ownership.unassigned[file].status || 'resists' };
  }
  for (const entryPath of Object.keys(ownership.unassigned)) {
    if (entryPath.endsWith('/') && file.startsWith(entryPath)) {
      return { context: null, status: ownership.unassigned[entryPath].status || 'resists' };
    }
  }
  return { context: null, status: 'never-examined' };
}

/**
 * The context-aware reading of one violation. Strictness is unchanged -- every
 * cross-module private call still fails -- but the message names the boundary
 * from the map: which context reaches out, or that the caller has no recorded
 * owning context and must be assigned in context-ownership.json first.
 */
function describeCall(file, hit, ownership) {
  const owner = ownerOf(file, ownership);
  if (!owner.context) {
    return `${file} (${owner.status}: no owning context recorded) reaches into another module's ${hit.call} -- assign it in context-ownership.json first`;
  }
  return `${file} (${owner.context}) reaches into another module's ${hit.call} -- contexts talk only through public contracts (#2446 rule 2)`;
}

/** Enforce published imports for the source/caller-backed portion of the map. */
function checkContextPorts(graph, ownership, today = new Date().toISOString().slice(0, 10)) {
  const problems = [];
  const activeLegacy = new Set();
  let crossOwnerCount = 0;
  for (const [from, deps] of graph) {
    const fromContext = ownerOf(from, ownership).context;
    if (!fromContext) continue;
    for (const to of new Set(deps)) {
      const toContext = ownerOf(to, ownership).context;
      if (!toContext || fromContext === toContext) continue;
      crossOwnerCount += 1;
      const edge = `${from}>${to}`;
      const port = (ownership.publishedPorts || {})[to];
      if (port && port.owner === toContext && port.consumers.includes(fromContext)) continue;
      const legacy = (ownership.legacyEdges || {})[edge];
      if (legacy) {
        activeLegacy.add(edge);
        if (legacy.reviewBy < today) problems.push(`expired legacy context import: ${edge}`);
      } else {
        problems.push(`unpublished cross-owner import: ${from} (${fromContext}) -> ${to} (${toContext})`);
      }
    }
  }
  for (const edge of Object.keys(ownership.legacyEdges || {})) {
    if (!activeLegacy.has(edge)) problems.push(`stale legacy context import: ${edge}`);
  }
  return { problems, crossOwnerCount };
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
  const ownership = loadOwnership();
  const files = listSourceFiles();
  const graph = buildGraph(files, files.filter((file) => !IS_TEST.test(file)));
  const ports = checkContextPorts(graph, ownership);

  if (update) {
    if (ports.problems.length > 0) {
      for (const problem of ports.problems) console.error(`FAIL ${problem}`);
      return 1;
    }
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

  const problems = grew.length + added.length + shrank.length + cleared.length + expired.length
    + ports.problems.length;
  if (problems === 0) {
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    const assigned = Object.keys(ownership.owners).length;
    const resists = Object.keys(ownership.unassigned).length;
    console.log(`OK: ${total} recorded cross-module private calls in ${counts.size} files, none added.`);
    console.log(`Context-aware (#2446): ${assigned} ownership entries, ${resists} resists-unassigned, 0 calls.`);
    console.log(`Context ports: ${ports.crossOwnerCount} mapped cross-owner imports checked.`);
    return 0;
  }

  for (const { file, count, detail: hits } of added) {
    console.error(`FAIL new: ${file} makes ${count} cross-module private call(s).`);
    for (const hit of hits.slice(0, 5)) console.error(`    ${describeCall(file, hit, ownership)} (line ${hit.line})`);
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
  for (const problem of ports.problems) console.error(`FAIL ${problem}`);
  console.error(
    '\nCall the other module through its public surface. If the member is'
    + '\nreally part of the contract, rename it without the underscore and'
    + '\ngive it a test; if it is not, do not call it from here.',
  );
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = { measure, violationsIn, loadOwnership, ownerOf, describeCall, checkContextPorts };
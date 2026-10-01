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
 * Context ownership (#2446 Map/Publish/Enforce, Wiki design decision v0.1 2026-09-25).
 * The map lives in context-ownership.json, generated from
 * docs/architecture/ownership-map-2446.md. Schema v2: owners holds the five
 * domain contexts ONLY; platform holds the explicit non-domain owner
 * (entrypoints, composition roots, transport adapters, generic infrastructure
 * flagged kind infra vs entry). There is no shared and no unassigned bucket.
 * outOfScope lists tooling/UI/example prefixes excluded from domain ownership
 * with reasons; the private-call ratchet above still covers them.
 * publishedPorts are FILE-level only (no directory inference): a cross-owner
 * import must target an explicitly published port of the target owner.
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
    if (typeof entry.evidence !== 'string' || !entry.evidence) {
      throw new Error(`context-ownership.json: missing evidence for ${entryPath}`);
    }
  }
  const platform = raw.platform && typeof raw.platform === 'object' ? raw.platform : {};
  for (const [entryPath, entry] of Object.entries(platform)) {
    if (!entry || (entry.kind !== 'infra' && entry.kind !== 'entry')) {
      throw new Error(`context-ownership.json: unknown platform kind for ${entryPath}`);
    }
    if (typeof entry.evidence !== 'string' || !entry.evidence) {
      throw new Error(`context-ownership.json: missing evidence for ${entryPath}`);
    }
  }
  const unassigned = raw.unassigned && typeof raw.unassigned === 'object' ? raw.unassigned : {};
  const outOfScope = Array.isArray(raw.outOfScope) ? raw.outOfScope : [];
  for (const entry of outOfScope) {
    if (!entry || typeof entry.prefix !== 'string' || !entry.prefix
      || typeof entry.reason !== 'string' || !entry.reason) {
      throw new Error('context-ownership.json: invalid outOfScope entry');
    }
  }
  const publishedPorts = raw.publishedPorts || {};
  const legacyEdges = raw.legacyEdges || {};
  const probe = { owners, platform, unassigned, outOfScope, contexts };
  for (const [port, rule] of Object.entries(publishedPorts)) {
    if (ownerOf(port, probe).context !== rule.owner
      || !Array.isArray(rule.consumers)
      || rule.consumers.some((context) => context !== 'Platform' && !contexts.has(context))
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
  return { contexts, owners, platform, unassigned, outOfScope, publishedPorts, legacyEdges };
}

function isOutOfScope(file, ownership) {
  return (ownership.outOfScope || []).some((entry) => file.startsWith(entry.prefix));
}

function ownerOf(file, ownership) {
  const owners = ownership.owners || {};
  if (Object.hasOwn(owners, file)) {
    return { context: owners[file].context, status: owners[file].status || 'assigned' };
  }
  const platform = ownership.platform || {};
  if (Object.hasOwn(platform, file)) {
    return { context: 'Platform', status: platform[file].kind || 'entry' };
  }
  if (isOutOfScope(file, ownership)) {
    return { context: null, status: 'out-of-scope' };
  }
  const unassigned = ownership.unassigned || {};
  if (Object.hasOwn(unassigned, file)) {
    return { context: null, status: unassigned[file].status || 'resists' };
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

/**
 * Enforce cross-owner imports (Wiki design decision v0.1).
 * - Domain -> Domain (different contexts): needs a FILE-level published port
 *   naming the caller's context, or a dated legacy edge.
 * - Domain -> Platform entrypoint: needs a dated legacy edge.
 *   Domain -> Platform infra (generic helpers): always allowed.
 * - Platform -> Domain: needs a FILE-level published port naming Platform
 *   (composition goes through public contracts), or a dated legacy edge.
 * - Platform -> Platform, anything -> Platform infra, out-of-scope: allowed.
 * Files with no recorded owner are not judged here; coverageStatus fails
 * them with an assignment instruction instead.
 */
function checkContextPorts(graph, ownership, today = new Date().toISOString().slice(0, 10)) {
  const problems = [];
  const activeLegacy = new Set();
  const ports = ownership.publishedPorts || {};
  const legacy = ownership.legacyEdges || {};
  let crossOwnerCount = 0;
  function legacyOrFail(edge) {
    const rule = legacy[edge];
    if (rule) {
      activeLegacy.add(edge);
      if (rule.reviewBy < today) problems.push(`expired legacy context import: ${edge}`);
      return true;
    }
    return false;
  }
  for (const [from, deps] of graph) {
    const fromCtx = ownerOf(from, ownership).context;
    if (!fromCtx) continue;
    for (const to of new Set(deps)) {
      const toOwn = ownerOf(to, ownership);
      const toCtx = toOwn.context;
      if (!toCtx || fromCtx === toCtx) continue;
      if (toCtx === 'Platform' && toOwn.status === 'infra') continue;
      crossOwnerCount += 1;
      const edge = `${from}>${to}`;
      if (toCtx === 'Platform') {
        if (fromCtx === 'Platform') continue;
        if (!legacyOrFail(edge)) {
          problems.push(`unpublished domain import of Platform entrypoint: ${from} (${fromCtx}) -> ${to}`);
        }
        continue;
      }
      const port = ports[to];
      const allowed = fromCtx === 'Platform' ? 'Platform' : fromCtx;
      if (port && port.owner === toCtx && port.consumers.includes(allowed)) continue;
      if (!legacyOrFail(edge)) {
        const who = fromCtx === 'Platform' ? `Platform import of domain port: ${from} -> ${to} (${toCtx})` : `unpublished cross-owner import: ${from} (${fromCtx}) -> ${to} (${toCtx})`;
        problems.push(who);
      }
    }
  }
  for (const edge of Object.keys(legacy)) {
    if (!activeLegacy.has(edge)) problems.push(`stale legacy context import: ${edge}`);
  }
  return { problems, crossOwnerCount };
}

/**
 * Coverage for #2446 Done-when: every in-scope file (non-test, not outOfScope)
 * resolves to exactly one owner. A file added without a manifest row fails
 * here with an assignment instruction (audit item: unmapped-file negative).
 */
function coverageStatus(ownership, files) {
  const unmapped = files
    .filter((file) => !IS_TEST.test(file) && !isOutOfScope(file, ownership)
      && ownerOf(file, ownership).status === 'never-examined')
    .sort();
  return { unmapped };
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

  const coverage = coverageStatus(ownership, files);

  if (update) {
    if (ports.problems.length > 0) {
  for (const problem of ports.problems) console.error(`FAIL ${problem}`);
  for (const file of coverage.unmapped.slice(0, 20)) {
    console.error(`FAIL unmapped: ${file} has no owning context; assign it in context-ownership.json with source+caller evidence first`);
  }
  if (coverage.unmapped.length > 20) {
    console.error(`FAIL unmapped: ... and ${coverage.unmapped.length - 20} more`);
  }
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
    + ports.problems.length + coverage.unmapped.length;
  if (problems === 0) {
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    const assigned = Object.keys(ownership.owners).length;
    const platform = Object.keys(ownership.platform || {}).length;
    const nports = Object.keys(ownership.publishedPorts || {}).length;
    const nlegacy = Object.keys(ownership.legacyEdges || {}).length;
    console.log(`OK: ${total} recorded cross-module private calls in ${counts.size} files, none added.`);
    console.log(`Context-aware (#2446): ${assigned} domain + ${platform} platform owners, ${nports} ports, ${nlegacy} legacy edges, 0 unmapped.`);
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

module.exports = { measure, violationsIn, loadOwnership, ownerOf, describeCall, checkContextPorts, coverageStatus, isOutOfScope };
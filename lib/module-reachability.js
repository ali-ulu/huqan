'use strict';

/**
 * Module reachability from the production entry points.
 *
 * A large part of this repository ships and is tested but is never executed by
 * the product: nothing in cli.js, server.js or mcpServer.js reaches it. Green
 * tests plus a `docs/` page describing a feature can then read as "this works",
 * when what is actually true is "this is implemented and unit-tested, and
 * nothing calls it". ADR-008 invariant 7 makes the same point for gates: a gate
 * existing in a library is not evidence that a production caller is enforced by
 * it.
 *
 * This module makes that distinction mechanical. It walks the static require
 * graph from the declared entry points and reports what it never reaches. Every
 * unreached file must then be classified, either as a legitimate non-required
 * artifact or as an explicitly acknowledged not-yet-wired module with a reason.
 * Anything unreached and unclassified fails the accompanying test, so a new
 * subsystem cannot quietly join the pile.
 *
 * Scope note: this is a *static* analysis of literal `require('./x')` calls. It
 * cannot see dynamic loads, which is why plugins are declared as entry points
 * below rather than being detected -- plugin.js loads them with readdirSync.
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Entry points the product itself runs.
 *
 * index.js is here because it is package.json's `main` (#329): it is what an
 * external consumer executes on `require('huqan')`, so it is a real entry
 * point even though no in-repo file requires it. kernel.js is kept listed for
 * the same reason -- it was `main` before the root export moved.
 *
 * bin/huqan-mcp.js is here on the same footing: package.json declares it as a
 * `bin`, so an installed consumer executes it directly. Nothing in this
 * repository requires it, and that is correct -- it is the outermost edge of
 * the MCP entry, not a module.
 */
const PRODUCTION_ENTRY_POINTS = Object.freeze([
  'cli.js',
  'server.js',
  'mcpServer.js',
  'bin/huqan-mcp.js',
  'index.js',
  'kernel.js',
  'github-app-server.js',
]);

/**
 * Directories whose files are loaded dynamically at runtime and so are
 * unreachable in a static graph while still genuinely running. plugin.js
 * enumerates this directory with readdirSync.
 */
const DYNAMIC_ENTRY_DIRS = Object.freeze(['plugins']);

/**
 * Files that are their own entry point -- run directly, never required. Being
 * unreachable from cli/server/mcp is correct for these, not a finding.
 */
const STANDALONE_PREFIXES = Object.freeze([
  'benchmarks/',
  'scripts/',
  'obsidian-plugin/',
  'packages/',
]);

const STANDALONE_FILES = Object.freeze([
  'demo-causal-autolearn.js',
  'scripts/egitim-demo.js', // npm run train
  'egitim.js', // #363: deprecation shim → scripts/egitim-demo.js (ships nothing, refuses to run)
]);

/** Package entry points executed by external consumers rather than this app. */
const CONSUMER_ENTRY_POINTS = Object.freeze([
  'packages/huqan-verify/index.js',
  // The AXIOM-era module name, re-exporting lib/huqan-package-format.js. It
  // ships so an external consumer that already requires it keeps working, and
  // nothing in this repository requires it -- which is the point, not an
  // oversight. Being unreached here is what proves the canonical name is the
  // one this codebase actually uses.
  'lib/axiom-package-format.js',
]);

/** Source modules that exist only to support tests, not a future product path. */
const TEST_ONLY_FILES = Object.freeze([
  'lib/self-test-oracle.js',
  // Deterministic coding benchmarks invoke this library from test fixtures only.
  'lib/deterministic-task-runner.js',
]);

/** Structural exports whose individual modules are the runtime entry surface. */
const STRUCTURAL_FILES = Object.freeze([
  'lib/causal/index.js',
]);

/**
 * Modules that are shipped and tested but not reached by any production entry
 * point. Each entry states why, so this list reads as a set of decisions rather
 * than as neglect.
 *
 * Removing an entry from this list is how a subsystem graduates: wire it up,
 * and the test stops requiring the acknowledgement.
 */
const NOT_YET_WIRED = Object.freeze({
  // --- V5 ------------------------------------------------------------------
  // ADR-010's V5_IMPLEMENTATION_ENTRY: FAIL used to be the reason nothing could
  // call these. That decision was superseded by
  // docs/v5/v5-implementation-entry-successor-audit.md.
  //
  // Four modules have since left this list the only way a module may: P0-B gave
  // them a production caller. POST /api/a2a/exchange reaches
  // lib/a2a/exchange-route.js, which reaches lib/a2a/bounded-exchange.js, which
  // requires the cryptographic profile contract, the verification adapter, the
  // public trust receipt importer and the trusted-key resolver.
  //
  // What remains is genuinely unreached. The list tracks that, not what is
  // forbidden, so deleting a line below would fail the check as a stale
  // acknowledgement rather than graduate anything.
  'lib/v5/runtime-reader.js': 'V5 library implementation; entry authorized, no production caller yet',
  'lib/v5/structural-signing-helper.js': 'V5 library implementation; entry authorized, no production caller yet',
  'schemas/v5/agent-identity-conformance.js': 'V5 schema implementation; entry authorized, no production caller yet',
  'schemas/v5/agent-identity-coverage.js': 'V5 schema implementation; entry authorized, no production caller yet',
  'schemas/v5/agent-identity-readiness.js': 'V5 schema implementation; entry authorized, no production caller yet',
  'schemas/v5/agent-identity-validator.js': 'V5 schema implementation; entry authorized, no production caller yet',

  // --- self-healer ---------------------------------------------------------
  // Library plus tests by design; the repo's "no autonomous Self-Healer"
  // non-goal means nothing here runs unattended. See #224.
  // The dogfood plugin reaches dryrun/finding/safety plus the bounded source
  // simulation path. audit-runner.js and finding-classifier.js remain separate
  // library surfaces and are still genuinely unreached.
  'lib/self-healer/index.js': 'self-healer is library-only by product decision; no autonomous runner',
  'lib/self-healer/audit-runner.js': 'self-healer is library-only by product decision',
  'lib/self-healer/finding-classifier.js': 'self-healer is library-only by product decision',

});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolveRequire(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * True when `candidate` really lives under `root` after both are canonicalized.
 *
 * Comparing the lexical path is not enough: the whole point is that a symlink's
 * name sits inside the repository while its target does not.
 */
function isWithinRoot(realRoot, candidate) {
  const relative = path.relative(realRoot, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Walk the repository for source files, without leaving it and without
 * revisiting a directory (#744).
 *
 * The previous walker used fs.statSync(), which follows symlinks, and kept no
 * record of where it had been. A checked-out symlink pointing at an external
 * directory was therefore treated as an ordinary directory and scanned — this
 * module is repository/CI architecture enforcement, so that meant reading host
 * paths that were never part of the repository — and an in-tree symlink cycle
 * such as `a/loop -> ..` recursed until the stack gave out.
 *
 * lstat() identifies the link itself rather than its target; realpath() decides
 * whether the target is still inside the repository; and the visited set is
 * keyed on the real path so a cycle terminates and an aliased directory is
 * walked once.
 */
function collectSourceFiles(root, dir = root, acc = [], visited = null) {
  const skip = new Set(['node_modules', '.git', 'docs', 'test', 'coverage']);
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch (_) {
    return acc;
  }
  const seenDirectories = visited || new Set();

  let realDir;
  try {
    realDir = fs.realpathSync(dir);
  } catch (_) {
    return acc;
  }
  if (!isWithinRoot(realRoot, realDir)) return acc;
  if (seenDirectories.has(realDir)) return acc;
  seenDirectories.add(realDir);

  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return acc;
  }

  for (const name of entries) {
    if (skip.has(name)) continue;
    const full = path.join(dir, name);

    let linkStat;
    try {
      linkStat = fs.lstatSync(full);
    } catch (_) {
      continue;
    }

    if (linkStat.isSymbolicLink()) {
      // Resolve before deciding anything: a link may name a directory outside
      // the repository, or one already walked under its real name.
      let realEntry;
      try {
        realEntry = fs.realpathSync(full);
      } catch (_) {
        continue;
      }
      if (!isWithinRoot(realRoot, realEntry)) continue;
      let realStat;
      try {
        realStat = fs.statSync(realEntry);
      } catch (_) {
        continue;
      }
      if (realStat.isDirectory()) {
        collectSourceFiles(root, realEntry, acc, seenDirectories);
      } else if (name.endsWith('.js') && !name.endsWith('.test.js') && !acc.includes(realEntry)) {
        acc.push(realEntry);
      }
      continue;
    }

    if (linkStat.isDirectory()) {
      collectSourceFiles(root, full, acc, seenDirectories);
    } else if (name.endsWith('.js') && !name.endsWith('.test.js')) {
      acc.push(full);
    }
  }
  return acc;
}

function walkRequires(file, seen) {
  if (seen.has(file)) return;
  seen.add(file);
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return;
  }
  for (const match of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const resolved = resolveRequire(file, match[1]);
    if (resolved) walkRequires(resolved, seen);
  }
}

function isStandalone(relPath) {
  return STANDALONE_FILES.includes(relPath)
    || STANDALONE_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

function isDynamicEntry(relPath) {
  return DYNAMIC_ENTRY_DIRS.some((dir) => relPath.startsWith(`${dir}/`));
}

/**
 * @param {object} [opts]
 * @param {string} [opts.root] repository root
 * @returns {{reachable: string[], unreachable: string[], unacknowledged: string[], staleAcknowledgements: string[]}}
 */
function analyzeReachability(opts = {}) {
  const root = isPlainObject(opts) && opts.root ? opts.root : path.join(__dirname, '..');
  const seen = new Set();

  const entries = [...PRODUCTION_ENTRY_POINTS, ...STANDALONE_FILES, ...CONSUMER_ENTRY_POINTS];
  for (const dir of DYNAMIC_ENTRY_DIRS) {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full)) {
      if (name.endsWith('.js')) entries.push(`${dir}/${name}`);
    }
  }

  for (const entry of entries) {
    const full = path.join(root, entry);
    if (fs.existsSync(full)) walkRequires(full, seen);
  }

  const all = collectSourceFiles(root).map((file) => path.relative(root, file).split(path.sep).join('/'));
  const reachable = all.filter((rel) => seen.has(path.join(root, rel))).sort();
  const unreachable = all.filter((rel) => !seen.has(path.join(root, rel))).sort();

  const unacknowledged = unreachable.filter((rel) => (
    !isStandalone(rel)
    && !isDynamicEntry(rel)
    && !TEST_ONLY_FILES.includes(rel)
    && !STRUCTURAL_FILES.includes(rel)
    && !Object.prototype.hasOwnProperty.call(NOT_YET_WIRED, rel)
  ));

  const staleAcknowledgements = Object.keys(NOT_YET_WIRED)
    .filter((rel) => !unreachable.includes(rel))
    .sort();

  return { reachable, unreachable, unacknowledged, staleAcknowledgements };
}

module.exports = {
  PRODUCTION_ENTRY_POINTS,
  DYNAMIC_ENTRY_DIRS,
  STANDALONE_PREFIXES,
  STANDALONE_FILES,
  CONSUMER_ENTRY_POINTS,
  TEST_ONLY_FILES,
  STRUCTURAL_FILES,
  NOT_YET_WIRED,
  analyzeReachability,
};

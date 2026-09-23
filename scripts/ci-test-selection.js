'use strict';

/**
 * Dependency-derived test selection for CI (#2610).
 *
 * `ci-impact-plan.js` used to decide which tests a pull request runs from a
 * hand-written table of glob pairs. That table has to be maintained by hand
 * against a moving tree, and when it drifts the failure mode is silent: the
 * plan looks healthy, selects 117 of 885 tests, and the tests that would have
 * caught the regression are simply not in the list.
 *
 * That is not hypothetical. #2505 C changed the identity gate's default from
 * allow to block for unattested calls, and changed `lib/external-action-
 * identity.js`. No impact rule matched `lib/external-action-*.js` at all, so
 * the plan selected 117 tests, none of the five suites that exercised the new
 * default, and main went red with 27 failures that surfaced a day later on the
 * nightly run.
 *
 * A table cannot be kept honest by hoping, so this module derives the
 * selection from the actual dependency graph instead. It recognises two kinds
 * of edge:
 *
 *   1. require edges, which are the ordinary case. Tests that transitively
 *      require a changed file are selected. This alone covers 3 of the 5
 *      suites #2505 C broke (the reachability numbers quoted below are
 *      measured against this repository, not estimated).
 *
 *   2. named-file edges, which cover dependencies a require graph cannot see.
 *      A test that spawns `bin/huqan-gate-hook.js` as a subprocess, or that
 *      loads `test/fixtures/deterministic-tasks/<name>.json` by name, depends
 *      on those files without ever requiring them -- and those are exactly the
 *      dependencies that go stale without anyone noticing. The other 2 of the
 *      5 suites are reached this way.
 *
 * Only the union of both edge kinds recovers all 5: 68 tests via require
 * alone, 111 with named-file edges added, and 5/5 recall only in the second
 * case.
 *
 * ## Why the named-file rule is narrow
 *
 * Treating every quoted string that looks like a path as an edge was measured
 * and rejected. It produces 1219 `.js` edges to 371 targets, and because a
 * careless mention of `server.js` from a widely-required helper fuses the
 * entire server closure into everything downstream, a single change then
 * selects 417 tests instead of 111. Recall stays perfect and the selection
 * stops being a selection.
 *
 * The rule kept here is the one that survived measurement: a named-file edge
 * to `.js` counts only when the *source* actually starts processes
 * (`spawnSync`/`execFileSync`/`exec`/`fork`/...). A file that runs programs has
 * to name the program it runs; a file that merely requires modules mentions
 * other files only in prose, and prose is not a dependency. That drops the
 * same measurement to 239 edges / 152 targets and a 111-test selection with
 * recall unchanged.
 *
 * Non-`.js` targets (fixtures, schemas, workflow files) keep the wide rule:
 * they are leaves that cannot fuse two closures together, so the cost that
 * forced the narrow rule does not apply, and they are the more valuable
 * signal -- a stale JSON fixture is invisible to every other gate.
 *
 * Scope note: this is a static analysis. A path assembled at runtime from
 * unrelated pieces is not detected, and neither is a file fetched over the
 * network. The `MUST_HAVE_PATTERNS` union in `ci-impact-plan.js` remains the
 * floor for the safety-critical surface: this module can only ever widen a
 * plan, never narrow one.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

/** Extensions a named-file literal may omit and still refer to a real file. */
const IMPLIED_EXTENSIONS = Object.freeze(['.js', '.json', '.md', '.txt', '.yaml', '.yml']);

/** Documentation paths named in prose far more often than they are used. */
const PROSE_ONLY_TARGET = /\.(md|txt)$/;

/**
 * Files that start processes. Used to decide whether a `.js` named in a string
 * is a program the file runs or merely a filename the file talks about.
 */
const STARTS_PROCESS = /\b(spawnSync|execFileSync|execSync|execFile|spawn|exec|fork)\s*\(/;

/**
 * Strips block and line comments before require() extraction.
 *
 * Same behaviour as `check-import-cycles.js`, which is the authority for the
 * cycle gate. Keeping the rule identical matters: a commented-out
 * `require('./x')` must not create an edge here either, or this selector and
 * that gate would disagree about what the graph contains.
 */
function stripComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

function normalizePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
}

function listTrackedFiles(root = REPO_ROOT) {
  const out = execFileSync('git', ['ls-files'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\n').map((line) => normalizePath(line.trim())).filter(Boolean);
}

function isTestFile(file) {
  const normalized = normalizePath(file);
  const base = path.posix.basename(normalized);
  if (normalized.startsWith('test/')) return base.endsWith('.js');
  return base.endsWith('.test.js')
    || base.endsWith('.spec.js')
    || base.endsWith('-test.js')
    || base.endsWith('_test.js')
    || (base.startsWith('test-') && base.endsWith('.js'))
    || base === 'test.js';
}

function isJavaScript(file) {
  return normalizePath(file).endsWith('.js');
}

/**
 * Resolves a literal require request to a tracked file.
 *
 * Resolves against the tracked-file set rather than the filesystem, so a
 * generated or ignored file that happens to sit on disk cannot become an edge
 * and the answer stays reproducible across machines and CI checkouts.
 */
function resolveRequest(fromFile, request, known) {
  if (!request.startsWith('.')) return null;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), request));
  if (known.has(target)) return target;
  if (known.has(`${target}.js`)) return `${target}.js`;
  if (known.has(`${target}/index.js`)) return `${target}/index.js`;
  return null;
}

/** Quoted string literals, including the inner quotes of a template literal. */
function quotedLiterals(source) {
  const literals = [];
  for (const match of String(source).matchAll(/(['"`])([^'"`\n]{2,200})\1/g)) {
    literals.push(match[2]);
  }
  return literals;
}

/**
 * Maps a quoted literal to a tracked file it could name.
 *
 * Two shapes are accepted, both anchored to a whole basename so an unrelated
 * substring cannot create an edge:
 *
 *   'bin/huqan-gate-hook.js'      -> exact tracked path
 *   'huqan-gate-hook.js'          -> basename match
 *   'real-huqan-...-rename'       -> basename plus an implied extension, which
 *                                    is how the deterministic-task fixture is
 *                                    loaded (`TASK_NAME` + `.json` inside the
 *                                    runner's own fixtures directory)
 *
 * A bare word is not accepted. Requiring either a path separator, a known
 * source extension, or a unique basename-plus-implied-extension keeps a
 * literal like 'rename' from selecting every file whose name contains it.
 */
function resolveNamedFile(literal, known, basenames) {
  const value = normalizePath(literal.trim());
  if (!value || value.length < 3) return null;
  if (known.has(value)) return value;

  const base = path.posix.basename(value);
  if (base.includes('.') && IMPLIED_EXTENSIONS.some((ext) => base.endsWith(ext))) {
    const matches = basenames.get(base);
    if (matches && matches.length === 1) return matches[0];
    return null;
  }

  // A bare stem is only meaningful when it does not look like prose: no spaces,
  // and it must be a prefix of exactly one tracked basename.
  if (/\s/.test(base) || base.length < 6) return null;
  const candidates = IMPLIED_EXTENSIONS.flatMap((ext) => basenames.get(`${base}${ext}`) || []);
  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0] : null;
}

function buildDependencyIndex({ root = REPO_ROOT, trackedFiles } = {}) {
  const tracked = (trackedFiles || listTrackedFiles(root)).map(normalizePath);
  const known = new Set(tracked);
  const basenames = new Map();
  for (const file of tracked) {
    const base = path.posix.basename(file);
    if (!basenames.has(base)) basenames.set(base, []);
    basenames.get(base).push(file);
  }

  const graph = new Map();
  for (const file of tracked) {
    if (!file.endsWith('.js')) {
      graph.set(file, []);
      continue;
    }
    let source;
    try {
      source = stripComments(fs.readFileSync(path.join(root, file), 'utf8'));
    } catch {
      graph.set(file, []);
      continue;
    }
    const edges = new Set();
    for (const match of source.matchAll(/require\(\s*['"`](\.[^'"`]+)['"`]\s*\)/g)) {
      const resolved = resolveRequest(file, match[1], known);
      if (resolved) edges.add(resolved);
    }

    const runsProcesses = STARTS_PROCESS.test(source);
    for (const literal of quotedLiterals(source)) {
      const named = resolveNamedFile(literal, known, basenames);
      if (!named || named === file || edges.has(named)) continue;
      if (PROSE_ONLY_TARGET.test(named)) continue;
      // A `.js` name is an edge only from a file that runs processes; see the
      // module comment for the measurement behind this restriction.
      if (isJavaScript(named) && !runsProcesses) continue;
      edges.add(named);
    }
    graph.set(file, [...edges].sort());
  }

  const tests = tracked.filter(isTestFile).sort();
  const closures = new Map();
  for (const test of tests) closures.set(test, reachableFrom(test, graph));

  const reverse = new Map();
  for (const [test, closure] of closures) {
    for (const file of closure) {
      if (!reverse.has(file)) reverse.set(file, new Set());
      reverse.get(file).add(test);
    }
  }

  return { tracked, known, graph, tests, closures, reverse };
}

function reachableFrom(start, graph) {
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const dep of graph.get(current) || []) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      stack.push(dep);
    }
  }
  return seen;
}

/**
 * Tests whose dependency closure contains a changed file.
 *
 * Returns a Map of test file to the changed files that pulled it in, so the
 * plan can explain a selection rather than just assert it.
 */
function deriveTestsForChange(changedFiles, index) {
  const derived = new Map();
  const add = (test, reason) => {
    if (!derived.has(test)) derived.set(test, []);
    if (!derived.get(test).includes(reason)) derived.get(test).push(reason);
  };

  for (const raw of changedFiles) {
    const file = normalizePath(raw);
    if (index.known.has(file) && isTestFile(file)) add(file, 'changed test file');
    for (const test of index.reverse.get(file) || []) add(test, `depends on ${file}`);
  }

  return new Map([...derived.entries()].map(([test, reasons]) => [test, reasons.sort()]));
}

/**
 * Selection for a change set, in the shape the impact plan consumes.
 *
 * Builds the dependency index when the caller does not already hold one, so a
 * caller that runs this once per process pays for the graph once.
 */
function selectionPlan(changedFiles, index) {
  const derived = deriveTestsForChange(changedFiles, index || buildDependencyIndex());
  return { tests: [...derived.keys()].sort(), reasons: derived };
}

/**
 * Fails when a plan advertises dependency-derived tests it does not run.
 *
 * A plan is only worth trusting if its own explanation matches its own
 * selection; this is the check that catches the two drifting apart.
 */
function assertDerivedTestsSelected(tests, selected) {
  for (const file of tests) {
    if (!selected.includes(file)) {
      throw new Error(`dependency-derived test is absent from selectedTests: ${file}`);
    }
  }
}

module.exports = {
  IMPLIED_EXTENSIONS,
  PROSE_ONLY_TARGET,
  REPO_ROOT,
  STARTS_PROCESS,
  assertDerivedTestsSelected,
  buildDependencyIndex,
  deriveTestsForChange,
  isJavaScript,
  isTestFile,
  listTrackedFiles,
  normalizePath,
  quotedLiterals,
  reachableFrom,
  resolveNamedFile,
  resolveRequest,
  selectionPlan,
  stripComments,
};

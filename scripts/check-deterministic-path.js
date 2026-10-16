#!/usr/bin/env node
'use strict';

/**
 * Deterministic-execution-path check (#2395, design #2384).
 *
 * The Deterministic Router's claim ("given identical input, this always
 * executes the same way, with no model in the loop") holds only if nothing
 * transitively reachable from the chosen procedure's execution path calls a
 * model. This is mechanically verified here, not asserted once in a design
 * doc: it statically walks the `require()` graph reachable from the
 * declared execution entrypoint(s) and fails if `llmAdapter.js` (or any
 * module tagged model-calling in MODEL_CALLING_MODULES) is in that
 * reachable set.
 *
 * Per #2384: "Until this check exists and passes, the deterministic-
 * execution claim is not made anywhere in the product." As of this check's
 * introduction it does NOT pass — see ENTRY_POINTS below and the CHECK
 * RESULT recorded in the PR/report that added this file. Do not remove or
 * weaken this check to make a claim true; fix the reachable path instead.
 *
 * Usage:  node scripts/check-deterministic-path.js
 * Exit 0 = no model-calling module reachable, exit 1 = at least one is.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

/**
 * The router itself never executes a procedure — it is pure (see
 * lib/experience/router.js's module doc). #2384 names workflow-agent.js as
 * "the candidate deterministic-execution substrate for the router", so that
 * is the entrypoint walked here. If a future PR gives the router (or a
 * Procedure Registry executor, #2393) its own dedicated execution entry
 * file, add it here — this list is meant to track the real call path, not a
 * fixed idea of what it is.
 */
const ENTRY_POINTS = Object.freeze([
  'workflow-agent.js',
  // #2396: PEM has no production caller yet (NOT_YET_WIRED in
  // lib/module-reachability.js), so nothing above already walks its
  // require graph. Listed here directly so the deterministic-execution
  // claim covers it too, per acceptance test 7 on #2396.
  'lib/experience/personal-execution-model.js',
]);

/**
 * Modules that call a model. llmAdapter.js is the only one named by #2384;
 * add here (not as a special case in the walker) if another module is
 * later identified as model-calling.
 */
const MODEL_CALLING_MODULES = Object.freeze([
  'llmAdapter.js',
]);

function resolveRequire(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Walk require()s reachable from `file`. Only literal, load-time
 * `require('./x')` calls are followed — same scope note as
 * lib/module-reachability.js and scripts/check-package-closure.js: this is
 * a static read, not a runtime trace, so a require hidden behind a function
 * call this file does not itself invoke would not be seen. That is a
 * documented limitation, not a silent one.
 */
function walkRequires(file, seen, edges) {
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
    if (!resolved) continue;
    edges.push([file, resolved]);
    walkRequires(resolved, seen, edges);
  }
}

/** Reconstruct the require chain from an entry point to `target`, for a
 * readable failure message (`a.js -> b.js -> llmAdapter.js`). */
function findPath(edges, fromFiles, target) {
  const adjacency = new Map();
  for (const [from, to] of edges) {
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from).push(to);
  }
  for (const start of fromFiles) {
    const queue = [[start]];
    const visited = new Set([start]);
    while (queue.length) {
      const chain = queue.shift();
      const last = chain[chain.length - 1];
      if (last === target) return chain;
      for (const next of adjacency.get(last) || []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push([...chain, next]);
      }
    }
  }
  return null;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.root] repository root
 * @param {string[]} [opts.entryPoints] repo-relative entry point files
 * @param {string[]} [opts.modelCallingModules] repo-relative model-calling files
 * @returns {{ ok: boolean, violations: Array<{ modelModule: string, chain: string[] }> }}
 */
function checkDeterministicPath(opts = {}) {
  const root = opts.root || repoRoot;
  const entryPoints = opts.entryPoints || ENTRY_POINTS;
  const modelModules = opts.modelCallingModules || MODEL_CALLING_MODULES;

  const seen = new Set();
  const edges = [];
  const entryFiles = [];
  for (const entry of entryPoints) {
    const full = path.join(root, entry);
    if (!fs.existsSync(full)) continue;
    entryFiles.push(full);
    walkRequires(full, seen, edges);
  }

  const violations = [];
  for (const modelModule of modelModules) {
    const target = path.join(root, modelModule);
    if (!seen.has(target)) continue;
    const chain = findPath(edges, entryFiles, target) || [target];
    violations.push({
      modelModule,
      chain: chain.map((f) => path.relative(root, f).split(path.sep).join('/')),
    });
  }

  return { ok: violations.length === 0, violations };
}

function main() {
  const result = checkDeterministicPath();
  if (result.ok) {
    process.stdout.write('check:deterministic-path: OK — no model-calling module reachable from the declared entry points.\n');
    process.exit(0);
  }
  process.stderr.write('check:deterministic-path: FAIL\n');
  process.stderr.write('The deterministic-execution claim cannot be made: a model-calling module is\n');
  process.stderr.write('transitively reachable from a declared execution entrypoint.\n\n');
  for (const violation of result.violations) {
    process.stderr.write(`  ${violation.modelModule} reachable via:\n`);
    process.stderr.write(`    ${violation.chain.join(' -> ')}\n`);
  }
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  ENTRY_POINTS,
  MODEL_CALLING_MODULES,
  checkDeterministicPath,
};

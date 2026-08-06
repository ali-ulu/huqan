#!/usr/bin/env node
'use strict';

/**
 * Fail if the CommonJS require graph contains a cycle (issue #327).
 *
 * Cycles in CommonJS are not a style problem: whichever module is required
 * first sees a partially-populated `module.exports` of the other, which
 * produces silent `undefined` values that are hard to reproduce in tests. Four
 * such cycles used to run straight through the correctness core (kernel,
 * graph, conflict-detector, provenance-ingest).
 *
 * Usage:  node scripts/check-import-cycles.js
 * Exit 0 = acyclic, exit 1 = at least one cycle.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');

// Test files are excluded: a test may legitimately reach back into anything,
// and the invariant being protected here is about the shipped runtime graph.
const EXCLUDE = /(^|\/)(node_modules|graphify-out)\//;
const IS_TEST = /(\.test\.js$|(^|\/)test\/|(^|\/)benchmarks\/|(^|\/)demo)/;

function listSourceFiles() {
  const out = execFileSync('git', ['ls-files', '*.js'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\n')
    .map((line) => line.trim().replace(/\\/g, '/'))
    .filter(Boolean)
    .filter((file) => !EXCLUDE.test(file));
}

function buildGraph(allFiles, sourceFiles) {
  const known = new Set(allFiles);

  const resolve = (fromFile, request) => {
    const target = path.posix.normalize(
      path.posix.join(path.posix.dirname(fromFile), request),
    );
    if (known.has(target)) return target;
    if (known.has(target + '.js')) return target + '.js';
    if (known.has(target + '/index.js')) return target + '/index.js';
    return null;
  };

  const graph = new Map();
  for (const file of sourceFiles) {
    const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    const deps = [...source.matchAll(/require\(\s*['"`](\.[^'"`]+)['"`]\s*\)/g)]
      .map((match) => resolve(file, match[1]))
      .filter((dep) => dep && !IS_TEST.test(dep));
    graph.set(file, deps);
  }
  return graph;
}

function findCycles(graph) {
  const onStack = new Set();
  const settled = new Set();
  const cycles = new Set();

  const visit = (node, trail) => {
    if (onStack.has(node)) {
      const start = trail.indexOf(node);
      cycles.add(trail.slice(start).concat(node).join(' -> '));
      return;
    }
    if (settled.has(node)) return;

    onStack.add(node);
    for (const dep of graph.get(node) || []) visit(dep, trail.concat(node));
    onStack.delete(node);
    settled.add(node);
  };

  for (const node of graph.keys()) visit(node, []);
  return [...cycles];
}

function main() {
  const allFiles = listSourceFiles();
  const sourceFiles = allFiles.filter((file) => !IS_TEST.test(file));
  const graph = buildGraph(allFiles, sourceFiles);
  const cycles = findCycles(graph);

  if (cycles.length === 0) {
    console.log(`OK: no require cycles across ${sourceFiles.length} source files.`);
    return 0;
  }

  console.error(`FAIL: ${cycles.length} require cycle(s) detected.\n`);
  for (const cycle of cycles) console.error('  ' + cycle);
  console.error(
    '\nA CommonJS cycle makes one module observe a partially-initialized',
    '\nexport of the other. Break it by moving the shared value into a leaf',
    '\nmodule that both sides can depend on downward.',
  );
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = { listSourceFiles, buildGraph, findCycles };

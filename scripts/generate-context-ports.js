#!/usr/bin/env node
'use strict';

/**
 * Reproduce the `publishedPorts` section of scripts/context-ownership.json from
 * the live require graph (#2446).
 *
 * docs/architecture/ownership-map-2446.md claims the 276 file-level ports were
 * "generated from the require graph at ea5a0e24". Without a committed script
 * that claim is not checkable: a reader has to trust it. This is that script.
 *
 * A port exists exactly when the gate would need one: a cross-context import
 * whose target is a domain file (the gate's own rule, see checkContextPorts).
 * Platform-owned targets are not ports -- they are dated legacy edges -- and
 * Platform infra targets are always allowed, so neither is emitted here.
 *
 *   node scripts/generate-context-ports.js           print the derived ports
 *   node scripts/generate-context-ports.js --check   compare against the manifest
 *
 * Exit 0 = the manifest matches the graph, exit 1 = drift (--check only).
 */

const { listSourceFiles, buildGraph } = require('./check-import-cycles.js');
const { loadOwnership, ownerOf } = require('./check-module-boundary.js');

const IS_TEST = /(\.test\.js$|(^|\/)test\/|(^|\/)benchmarks\/|(^|\/)demo)/;

function derivePorts(ownership, graph) {
  const ports = new Map();
  for (const [from, deps] of graph) {
    const fromCtx = ownerOf(from, ownership).context;
    if (!fromCtx) continue;
    for (const to of new Set(deps)) {
      const toOwner = ownerOf(to, ownership);
      const toCtx = toOwner.context;
      if (!toCtx || fromCtx === toCtx) continue;
      if (toCtx === 'Platform' && toOwner.status === 'infra') continue;
      if (toCtx === 'Platform') continue;
      const consumer = fromCtx === 'Platform' ? 'Platform' : fromCtx;
      if (!ports.has(to)) ports.set(to, { owner: toCtx, consumers: new Set() });
      ports.get(to).consumers.add(consumer);
    }
  }
  return new Map(
    [...ports].map(([file, port]) => [file, {
      owner: port.owner,
      consumers: [...port.consumers].sort(),
    }]),
  );
}

function buildGraphFromRepo() {
  const allFiles = listSourceFiles();
  const sourceFiles = allFiles.filter((file) => !IS_TEST.test(file));
  return buildGraph(allFiles, sourceFiles);
}

/** Drift between the derived ports and the manifest's, as readable strings. */
function diffPorts(derived, committed) {
  const problems = [];
  for (const [file, port] of derived) {
    const recorded = committed[file];
    if (!recorded) {
      problems.push(`missing port: ${file} (${port.owner}; consumers ${port.consumers.join(', ')})`);
      continue;
    }
    if (recorded.owner !== port.owner) {
      problems.push(`owner drift: ${file} is ${recorded.owner} in the manifest, ${port.owner} in the graph`);
    }
    const recordedConsumers = [...(recorded.consumers || [])].sort();
    if (recordedConsumers.join(',') !== port.consumers.join(',')) {
      problems.push(`consumer drift: ${file} has [${recordedConsumers.join(', ')}] in the manifest, [${port.consumers.join(', ')}] in the graph`);
    }
  }
  for (const file of Object.keys(committed)) {
    if (!derived.has(file)) problems.push(`stale port: ${file} is published but no cross-context import needs it`);
  }
  return problems;
}

function main() {
  const check = process.argv.includes('--check');
  const ownership = loadOwnership();
  const derived = derivePorts(ownership, buildGraphFromRepo());

  if (!check) {
    console.log(JSON.stringify(Object.fromEntries(derived), null, 2));
    return 0;
  }

  const problems = diffPorts(derived, ownership.publishedPorts || {});
  if (problems.length > 0) {
    for (const problem of problems) console.error(`FAIL ${problem}`);
    console.error(`\n${problems.length} published-port problem(s); re-derive with scripts/generate-context-ports.js`);
    return 1;
  }
  console.log(`OK: ${derived.size} published ports reproduced from the require graph.`);
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { derivePorts, diffPorts };

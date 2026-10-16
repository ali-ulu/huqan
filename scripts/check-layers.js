#!/usr/bin/env node
'use strict';

/**
 * Fail when a require points the wrong way through the layers
 * (docs/architecture-policy.md §3).
 *
 *   entrypoint (cli, server, mcpServer, index, agentRuntime)
 *     -> use case / domain (lib/, kernel, graph, agent, workflow)
 *       -> storage (storage.js, lib/storage/, lib/memory-store.js)
 *
 * An entrypoint may reach down; nothing may reach back up. A library that
 * requires `server.js` drags an HTTP server into every consumer that only
 * wanted the library, and makes the library impossible to test without
 * standing one up. A storage module that requires the kernel means the
 * persistence layer cannot be swapped or exercised on its own.
 *
 * Unlike the other two gates this one is nearly clean already: three upward
 * edges across three files. They are listed in ALLOWED with a review date
 * rather than silently tolerated, because an exception without a date is how
 * the previous architecture document turned into a freeze.
 *
 * Usage:  node scripts/check-layers.js
 * Exit 0 = directions hold, exit 1 = at least one upward edge.
 */

const { listSourceFiles, buildGraph } = require('./check-import-cycles.js');

const IS_TEST = /(\.test\.js$|(^|\/)test\/|(^|\/)benchmarks\/|(^|\/)demo)/;

const ENTRYPOINT = new Set([
  'cli.js', 'server.js', 'mcpServer.js', 'index.js', 'agentRuntime.js',
]);
// The persistence family, not just its facade: splitting a store into
// `lib/memory-store-write.js` and friends does not move those pieces into a
// higher layer, and a gate that thought so would punish exactly the kind of
// decomposition this policy is asking for.
const STORAGE = (file) => file === 'storage.js'
  || file.startsWith('lib/storage/')
  || /^lib\/(memory|sqlite)-/.test(file);

/**
 * Shared helpers carry no layer of their own, so any layer may depend
 * downward onto one. A module with no internal requires is obviously such a
 * helper -- but so is one whose entire dependency closure is helpers, and a
 * definition that stopped at the first case would misread `lib/text-utils.js`
 * as domain code that storage must not touch.
 *
 * Computed as a fixpoint: start from the modules that require nothing, then
 * repeatedly admit any module all of whose dependencies are already in.
 * Entrypoints are never admitted, however few dependencies they have.
 */
function sharedOf(graph, isEntrypoint) {
  const shared = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [file, deps] of graph) {
      if (shared.has(file) || isEntrypoint(file)) continue;
      if (deps.every((dep) => shared.has(dep))) {
        shared.add(file);
        grew = true;
      }
    }
  }
  return shared;
}

const RANK = { entrypoint: 0, domain: 1, storage: 2, shared: 3 };

const isEntrypoint = (file) => ENTRYPOINT.has(file)
  || file.startsWith('bin/') || file.startsWith('scripts/') || file.startsWith('examples/');

const layerOf = (file, shared) => {
  if (isEntrypoint(file)) return 'entrypoint';
  if (shared.has(file)) return 'shared';
  if (STORAGE(file)) return 'storage';
  return 'domain';
};

/**
 * Known upward edges, kept explicit. Each entry states why it exists and
 * when the decision is revisited; an expired entry fails the gate exactly
 * like a new violation, so tolerance cannot become permanent by neglect.
 */
const ALLOWED = [
  {
    from: 'lib/http/memory-approval-routes.js',
    to: 'mcpServer.js',
    why: 'The approval route re-uses the MCP tool handlers rather than duplicating them. '
      + 'Resolved by extracting the shared handlers into a use-case module.',
    review_by: '2026-12-31',
  },
  {
    from: 'lib/http/fitness-dashboard-route.js',
    to: 'scripts/fitness-dashboard.js',
    why: 'The route renders the dashboard the script builds. Resolved by moving '
      + 'the rendering into a module both the route and the script may require.',
    review_by: '2026-12-31',
  },
  {
    from: 'lib/mcp-agent-approval-execution.js',
    to: 'agentRuntime.js',
    why: 'Approval execution drives the same runtime the entrypoint builds. '
      + 'Resolved by injecting the runtime instead of requiring its factory.',
    review_by: '2026-12-31',
  },
];

function isAllowed(from, to) {
  return ALLOWED.some((entry) => entry.from === from && entry.to === to);
}

function main() {
  const all = listSourceFiles();
  const source = all.filter((file) => !IS_TEST.test(file));
  const graph = buildGraph(all, source);

  const shared = sharedOf(graph, isEntrypoint);
  const violations = [];
  for (const [file, deps] of graph) {
    const from = layerOf(file, shared);
    for (const dep of new Set(deps)) {
      const to = layerOf(dep, shared);
      if (RANK[to] >= RANK[from]) continue;
      if (isAllowed(file, dep)) continue;
      violations.push({ file, dep, from, to });
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const expired = ALLOWED.filter((entry) => entry.review_by < today);
  const stale = ALLOWED.filter((entry) => {
    const deps = graph.get(entry.from) || [];
    return !deps.includes(entry.to);
  });

  if (violations.length === 0 && expired.length === 0 && stale.length === 0) {
    console.log(
      `OK: layer directions hold across ${source.length} source files `
      + `(${ALLOWED.length} recorded exceptions).`,
    );
    return 0;
  }

  for (const { file, dep, from, to } of violations) {
    console.error(`FAIL: ${file} (${from}) requires ${dep} (${to}) -- that points upward.`);
  }
  for (const entry of expired) {
    console.error(`FAIL expired: the ${entry.from} -> ${entry.to} exception was due by ${entry.review_by}.`);
  }
  for (const entry of stale) {
    console.error(`FAIL stale: the ${entry.from} -> ${entry.to} exception is no longer needed; remove it.`);
  }
  console.error(
    '\nInvert the dependency: pass what the lower layer needs in, or move the'
    + '\nshared piece down into a module both sides may depend on.',
  );
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = { layerOf, sharedOf, ALLOWED };

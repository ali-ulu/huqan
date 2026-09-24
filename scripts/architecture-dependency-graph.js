#!/usr/bin/env node
'use strict';

/**
 * The module-level layer map and the direction rule behind #2641 (A6).
 *
 * scripts/check-layers.js already answers "may this require point from A to
 * B?". Its rings are named for the job each one does -- entrypoint, domain,
 * storage, shared -- and it derives the innermost ring as a fixpoint over the
 * graph. #2641 asks for the same graph under the four names a reader arriving
 * from Clean Architecture expects, and for the artifact to carry every module,
 * every directed import edge and every edge that points the wrong way, so a
 * drift check can fail on the next one.
 *
 * Ring order, outermost first: UI -> Application -> Adapters -> Core. An edge
 * is a violation when it points from an inner ring at a more outward one, which
 * makes `Core -> UI` and `Core -> Adapters` (#2641's two examples) violations,
 * together with `Core -> Application` and `Application -> UI`. That last edge is
 * the class scripts/check-layers.js records as debt today: the two gates agree
 * on direction and differ only in range. check-layers.js says nothing about
 * whether the domain may require the storage family; this gate does, and the
 * edges where it is stricter are recorded in the baseline rather than argued
 * away.
 *
 * Assignment is a path rule and never a fallback. A tracked module that matches
 * no rule is *unassigned* and the gate fails on it, instead of letting a new
 * directory inherit Core because nobody looked. Assignment is deliberately not
 * derived from the dependency closure: the graph moves every day, and a layer
 * that moves with it cannot be reviewed as a decision.
 */

const { pairCarriedViolations } = require('./architecture-carried-violations');
const RINGS = ['UI', 'Application', 'Adapters', 'Core'];
const RANK = Object.freeze({ UI: 0, Application: 1, Adapters: 2, Core: 3 });

// The flag the issue names, plus the spelling this repository already uses.
const UPDATE_FLAGS = ['--update', '--update-baseline'];

// Drift within one PR is normal: a split rewrites a module and every module
// that required it, so a single file move can touch forty edges. Above this the
// change is large enough that the graph is no longer the one in the baseline,
// and the baseline must move deliberately with the PR.
const DEFAULT_DRIFT_THRESHOLD = 50;

/**
 * Every tracked module with no other home lands in Core, which is why each
 * rule below is a path and why there is no catch-all. The rules are ordered:
 * the first match wins, so the persistence prefixes are read before the flat
 * `lib/*.js` domain rule that would otherwise swallow them.
 */
const RULES = [
  {
    layer: 'UI',
    why: 'Process entrypoints, and the inbound surfaces a caller drives HUQAN through. Nothing may require these; they require everything below.',
    files: ['cli.js', 'server.js', 'mcpServer.js', 'github-app-server.js', 'index.js'],
    dirs: ['bin/', 'scripts/', 'examples/', 'public/', 'lib/http/', 'lib/mcp/', 'lib/viewer/', 'lib/workbench/'],
  },
  {
    layer: 'Adapters',
    why: 'The persistence family and the modules that talk to something outside the process -- a file, a database, a socket, a model. They may know Core; Core may not know them.',
    files: ['storage.js', 'persistencePaths.js', 'backupRestore.js', 'llmAdapter.js', 'rustGraph.js', 'sandboxRunner.js'],
    dirs: ['adapters/', 'packages/', 'lib/storage/', 'lib/connectors/', 'lib/interop/', 'lib/llm-proxy/'],
    pattern: /^lib\/(memory|sqlite)-/,
  },
  {
    layer: 'Application',
    why: 'The use cases: the runtimes that drive a turn, the feature packages that implement one capability, and the extension surface plugins are written against.',
    files: [
      'agent.js', 'agent.v3.js', 'agentRuntime.js', 'dream.js', 'finalizer.js', 'plugin.js',
      'workflow-agent.js', 'workflow-runtime.js', 'workflow-tools.js',
    ],
    dirs: [
      'plugins/', 'lib/a2a/', 'lib/automation-safety-gate/', 'lib/causal/', 'lib/coder/', 'lib/error-prevention/',
      'lib/experience/', 'lib/memory-mutation-gate/', 'lib/observability/', 'lib/pilot/', 'lib/pr-guardian/',
      'lib/receipt/', 'lib/registry/', 'lib/self-healer/', 'lib/trust-signals/', 'lib/v5/', 'lib/verdict/',
    ],
  },
  {
    layer: 'Core',
    why: 'The domain: the kernel and graph, the policy and ranking modules they are built from, the flat `lib/*.js` modules that implement domain rules, and the pure data contracts under schemas/.',
    files: [
      'causalSimulator.js', 'egitim.js', 'evidence-ranker.js', 'graph.js', 'kernel.js', 'kernel.v2.js',
      'requestGuards.js', 'toolPolicy.js',
    ],
    dirs: ['nlp/', 'lib/errors/', 'schemas/'],
    pattern: /^lib\/[^/]+\.js$/,
  },
];

function matchesRule(rule, file) {
  if (rule.files && rule.files.includes(file)) return true;
  if (rule.dirs && rule.dirs.some((dir) => file.startsWith(dir))) return true;
  return Boolean(rule.pattern && rule.pattern.test(file));
}

/**
 * @param {string} file repo-relative, forward slashes
 * @returns {'UI'|'Application'|'Adapters'|'Core'|null} null when no rule claims it
 */
function assignLayer(file) {
  for (const rule of RULES) {
    if (matchesRule(rule, file)) return rule.layer;
  }
  return null;
}

/** The rule that claimed a module, for the failure message that explains it. */
function ruleFor(file) {
  return RULES.find((rule) => matchesRule(rule, file)) || null;
}

const isViolation = (fromLayer, toLayer) => RANK[toLayer] < RANK[fromLayer];

const edgeKey = (edge) => `${edge.from}>${edge.to}`;

const describe = (edge) => `${edge.from} (${edge.fromLayer}) -> ${edge.to} (${edge.toLayer})`;

function sortedDict(source) {
  return Object.fromEntries(Object.entries(source).sort(([a], [b]) => a.localeCompare(b)));
}

function sortedEdges(source) {
  const out = {};
  for (const file of Object.keys(source).sort()) out[file] = [...source[file]].sort();
  return out;
}

/**
 * The A6 snapshot: every module under exactly one ring, every directed import
 * edge, and the edges that point outward recorded as violations.
 *
 * An edge touching an unassigned module is left out of the graph rather than
 * guessed at: the unassigned list already fails the gate, and a violation
 * derived from a layer nobody assigned would be a claim the tree does not
 * support.
 *
 * @param {Map<string, string[]>} graph output of check-import-cycles.buildGraph
 */
function buildDependencySnapshot(graph) {
  const layers = {};
  const unassigned = [];
  for (const file of [...graph.keys()].sort()) {
    const layer = assignLayer(file);
    if (layer) layers[file] = layer;
    else unassigned.push(file);
  }

  const edges = {};
  const violations = [];
  for (const file of Object.keys(layers)) {
    for (const dep of [...new Set(graph.get(file) || [])].sort()) {
      if (!layers[dep]) continue;
      if (edges[file]) edges[file].push(dep);
      else edges[file] = [dep];
      if (isViolation(layers[file], layers[dep])) {
        violations.push({ from: file, to: dep, fromLayer: layers[file], toLayer: layers[dep] });
      }
    }
  }
  violations.sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));

  return { layers, edges, violations, unassigned };
}

/** The recorded section of scripts/architecture-tracker-baseline.json. */
function dependencyGraphBaseline(baseline) {
  if (!baseline || typeof baseline.dependencyGraph !== 'object' || baseline.dependencyGraph === null) return null;
  return baseline.dependencyGraph;
}

/**
 * How far the live graph has moved from the recorded one: modules that
 * appeared or went away, modules that changed ring, and edge endpoints that
 * were added or removed. A move is one module plus its incident edges, so the
 * number is a shape measurement, not a count of mistakes.
 */
function driftCount(current, baseline) {
  if (!baseline) return 0;
  const baseLayers = baseline.layers || {};
  const baseEdges = baseline.edges || {};
  let drift = 0;

  for (const [file, layer] of Object.entries(current.layers)) {
    if (baseLayers[file] === undefined || baseLayers[file] !== layer) drift += 1;
  }
  for (const file of Object.keys(baseLayers)) {
    if (!(file in current.layers)) drift += 1;
  }
  for (const [file, deps] of Object.entries(current.edges)) {
    const recorded = new Set(baseEdges[file] || []);
    for (const dep of deps) if (!recorded.has(dep)) drift += 1;
  }
  for (const [file, deps] of Object.entries(baseEdges)) {
    const live = new Set(current.edges[file] || []);
    for (const dep of deps) if (!live.has(dep)) drift += 1;
  }
  return drift;
}

/**
 * Deliberate acceptances of a violation, on scripts/check-layers.js's terms: a
 * reason and a review date, with `--check` failing on an entry that expired or
 * that no longer describes a live edge. Existing violations are not listed here
 * -- they are the recorded baseline, which is machine-written, reviewed as a
 * diff, and may only shrink.
 *
 * @type {ReadonlyArray<{from: string, to: string, why: string, review_by: string}>}
 */
const LAYER_EXCEPTIONS = Object.freeze([
  {
    from: 'lib/provenance-query-trust-receipt.js',
    to: 'lib/causal/causal-verdict.js',
    why: 'The trust-receipt causal bridge block normalizes a caller-supplied causal verdict into'
      + ' the published receipt shape. The same Core -> Application edge was a recorded baseline'
      + ' violation on lib/provenance-query.js; #2162 split that file and the edge moved onto the'
      + ' new module name, which the cannot-add-debt ratchet treats as new. The verdict stays'
      + ' caller-supplied (no production caller passes one), so the follow-up fix is to lift the'
      + ' bridge behind an injected normalizer rather than move the causal verdict into Core.',
    review_by: '2026-12-31',
  },
]);

function exceptionMessages(exceptions, current, today) {
  const live = new Set(current.violations.map(edgeKey));
  const messages = [];
  for (const entry of exceptions) {
    if (entry.review_by < today) {
      messages.push(`FAIL expired layer exception: ${entry.from} -> ${entry.to} was due by ${entry.review_by}.`);
    } else if (!live.has(`${entry.from}>${entry.to}`)) {
      messages.push(`FAIL stale layer exception: ${entry.from} -> ${entry.to} is no longer a live violation.`);
    }
  }
  return messages;
}

function resolveThreshold(argv, baseline) {
  const override = argv.map((arg) => arg.match(/^--drift-threshold=(\d+)$/)).find(Boolean);
  if (override) return Number(override[1]);
  return baseline && Number.isInteger(baseline.threshold) ? baseline.threshold : DEFAULT_DRIFT_THRESHOLD;
}

function recordedSection(current, threshold) {
  return {
    threshold,
    layers: sortedDict(current.layers),
    edges: sortedEdges(current.edges),
    violations: current.violations.map((edge) => ({
      from: edge.from,
      to: edge.to,
      fromLayer: edge.fromLayer,
      toLayer: edge.toLayer,
    })),
  };
}

/**
 * Compare the live graph against the recorded one.
 *
 * Three findings fail outright, and `--update` excuses none of them: a module
 * with no ring, a violation that is neither recorded nor covered by a dated
 * exception, and a stale or expired exception. Everything else -- a violation
 * that was fixed, a module that changed ring, drift above the threshold -- is a
 * change to the recorded architecture, so it fails until the baseline is moved
 * on purpose with `npm run arch:snapshot -- --update`.
 *
 * The first run has no recorded graph to compare against. That is the one time
 * `--update` may record violations at their current size; from then on the
 * recorded set is a ceiling that may only fall.
 *
 * `exceptions` defaults to LAYER_EXCEPTIONS, which describe the live tree; a
 * caller checking a fixture graph passes its own list, since a real exception
 * is necessarily stale against a graph that does not contain its module.
 *
 * @returns {{ok: boolean, messages: string[], recorded: object|null, threshold: number}}
 */
function checkDependencyGraph(current, baseline, argv = [], previous = null, exceptions = LAYER_EXCEPTIONS) {
  const update = argv.some((arg) => UPDATE_FLAGS.includes(arg));
  const threshold = resolveThreshold(argv, baseline);
  const today = new Date().toISOString().slice(0, 10);
  const messages = [];
  const excepted = new Set(exceptions.map(edgeKey));

  if (current.unassigned.length > 0) {
    messages.push(
      `FAIL unassigned: ${current.unassigned.length} module(s) match no layer rule in scripts/architecture-dependency-graph.js:`,
      ...current.unassigned.slice(0, 10).map((file) => `    ${file}`),
    );
    if (current.unassigned.length > 10) messages.push(`    ...and ${current.unassigned.length - 10} more.`);
  }
  messages.push(...exceptionMessages(exceptions, current, today));

  // The committed baseline may not grow relative to the base ref either: the
  // ratchet that keeps the size tracker honest is the same one, and a PR that
  // edits a violation into the baseline is adding debt, not recording it.
  if (previous) {
    const before = new Set((previous.violations || []).map((edge) => `${edge.from}>${edge.to}`));
    const kept = new Set((baseline?.violations || []).map(edgeKey));
    const { unexplained: gained } = pairCarriedViolations(
      (baseline?.violations || []).filter((edge) => !before.has(edgeKey(edge)) && !excepted.has(edgeKey(edge))),
      (previous.violations || []).filter((edge) => !kept.has(edgeKey(edge))), previous.layers);
    if (gained.length > 0) {
      messages.push(
        `FAIL baseline cannot add debt: ${gained.length} violation(s) in this branch's baseline are not in the base ref's:`,
        ...gained.slice(0, 5).map((edge) => `    ${describe(edge)}`),
      );
    }
  }

  // No recorded graph means nothing to compare against. Seeding it is a
  // deliberate act, not something `--check` may do by passing quietly.
  if (!baseline && !update) {
    messages.push('FAIL: the architecture baseline carries no dependency graph; rerun with --update to seed it (#2641).');
  }

  if (baseline) {
    const recorded = new Set((baseline.violations || []).map((edge) => `${edge.from}>${edge.to}`));
    const live = new Set(current.violations.map(edgeKey));
    const { unexplained: added, stillGone: fixed } = pairCarriedViolations(
      current.violations.filter((edge) => !recorded.has(edgeKey(edge)) && !excepted.has(edgeKey(edge))),
      (baseline.violations || []).filter((edge) => !live.has(edgeKey(edge))), baseline.layers);
    if (added.length > 0) {
      messages.push(
        `FAIL new layer violation(s) (${added.length}):`,
        ...added.slice(0, 10).map((edge) => `    ${describe(edge)}`),
      );
      if (added.length > 10) messages.push(`    ...and ${added.length - 10} more.`);
      messages.push('    Point the edge the other way: pass the collaborator in, or move the shared piece to an inner ring.');
    }

    if (!update) {
      if (fixed.length > 0) {
        messages.push(
          `FAIL unrecorded gain: ${fixed.length} recorded layer violation(s) are gone; rerun with --update to lock the gain in.`,
          ...fixed.slice(0, 5).map((edge) => `    ${describe(edge)}`),
        );
      }
      const moved = Object.entries(current.layers)
        .filter(([file, layer]) => {
          const recorded = (baseline.layers || {})[file];
          return recorded !== undefined && recorded !== layer;
        });
      if (moved.length > 0) {
        messages.push(
          `FAIL reassigned: ${moved.length} module(s) changed ring; rerun with --update if the move is deliberate.`,
          ...moved.slice(0, 5).map(([file, layer]) => `    ${file}: ${(baseline.layers || {})[file]} -> ${layer}`),
        );
      }
      const drift = driftCount(current, baseline);
      if (drift > threshold) {
        messages.push(
          `FAIL drift: the module graph moved in ${drift} places, over the recorded threshold of ${threshold}`
          + ' (--drift-threshold=N overrides it); rerun with --update if the change is intended.',
        );
      }
    }
  }

  const ok = messages.length === 0;
  return { ok, messages, recorded: ok ? recordedSection(current, threshold) : null, threshold };
}

/** The `--graph` report: what the gate sees right now, in one screen. */
function renderGraphSummary(current, threshold = DEFAULT_DRIFT_THRESHOLD) {
  const perRing = Object.fromEntries(RINGS.map((ring) => [ring, 0]));
  for (const layer of Object.values(current.layers)) perRing[layer] += 1;
  const byPair = new Map();
  for (const edge of current.violations) {
    const key = `${edge.fromLayer} -> ${edge.toLayer}`;
    byPair.set(key, (byPair.get(key) || 0) + 1);
  }
  const lines = [
    `modules: ${Object.keys(current.layers).length} assigned, ${current.unassigned.length} unassigned`,
    `rings: ${RINGS.map((ring) => `${ring} ${perRing[ring]}`).join(', ')}`,
    `directed edges: ${Object.values(current.edges).reduce((sum, deps) => sum + deps.length, 0)}`,
    `layer violations: ${current.violations.length}`,
  ];
  for (const [pair, count] of [...byPair.entries()].sort()) lines.push(`  ${count}\t${pair}`);
  lines.push(`drift threshold: ${threshold}`);
  for (const file of current.unassigned.slice(0, 10)) lines.push(`  unassigned\t${file}`);
  return lines.join('\n');
}

module.exports = {
  RINGS,
  RANK,
  RULES,
  UPDATE_FLAGS,
  DEFAULT_DRIFT_THRESHOLD,
  assignLayer,
  ruleFor,
  isViolation,
  edgeKey,
  describe,
  buildDependencySnapshot,
  dependencyGraphBaseline,
  driftCount,
  LAYER_EXCEPTIONS,
  checkDependencyGraph,
  renderGraphSummary,
};

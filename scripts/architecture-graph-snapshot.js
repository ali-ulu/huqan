'use strict';

const fs = require('fs');
const path = require('path');
const { listSourceFiles, buildGraph } = require('./check-import-cycles');
const {
  layerOf,
  sharedOf,
  isEntrypoint,
  isAllowed,
  RANK,
} = require('./check-layers');

const IS_TEST = /(\.test\.js$|(^|\/)test\/|(^|\/)benchmarks\/|(^|\/)demo)/;
const GRAPH_POLICY_PATH = path.join(__dirname, 'architecture-graph-policy.json');

function readGraphPolicy(policyPath = GRAPH_POLICY_PATH) {
  const value = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  const maxGraphChurnRatio = Number(value.maxGraphChurnRatio);
  if (!Number.isFinite(maxGraphChurnRatio) || maxGraphChurnRatio < 0 || maxGraphChurnRatio > 1) {
    throw new Error('architecture graph policy maxGraphChurnRatio must be between 0 and 1');
  }
  return { maxGraphChurnRatio };
}

function buildArchitectureGraphSnapshot() {
  const all = listSourceFiles();
  const source = all.filter((file) => !IS_TEST.test(file));
  const graph = buildGraph(all, source);
  const shared = sharedOf(graph, isEntrypoint);
  const modules = {};
  const edges = [];
  const violations = [];

  for (const file of [...graph.keys()].sort()) modules[file] = layerOf(file, shared);

  for (const from of [...graph.keys()].sort()) {
    const fromLayer = modules[from];
    for (const to of [...new Set(graph.get(from) || [])].sort()) {
      const toLayer = modules[to] || layerOf(to, shared);
      const edge = { from, to, fromLayer, toLayer };
      edges.push(edge);
      if (RANK[toLayer] < RANK[fromLayer] && !isAllowed(from, to)) violations.push(edge);
    }
  }

  return {
    schemaVersion: 1,
    modules,
    edges,
    violations,
  };
}

function edgeKey(edge) {
  return `${edge.from}->${edge.to}`;
}

function graphChurn(previous, current) {
  const previousModules = previous?.modules || {};
  const currentModules = current?.modules || {};
  const moduleNames = new Set([...Object.keys(previousModules), ...Object.keys(currentModules)]);
  let moduleChanges = 0;
  for (const name of moduleNames) {
    if (previousModules[name] !== currentModules[name]) moduleChanges += 1;
  }

  const previousEdges = new Set((previous?.edges || []).map(edgeKey));
  const currentEdges = new Set((current?.edges || []).map(edgeKey));
  let edgeChanges = 0;
  for (const edge of previousEdges) if (!currentEdges.has(edge)) edgeChanges += 1;
  for (const edge of currentEdges) if (!previousEdges.has(edge)) edgeChanges += 1;

  const denominator = Math.max(1, Object.keys(previousModules).length + previousEdges.size);
  return {
    moduleChanges,
    edgeChanges,
    ratio: (moduleChanges + edgeChanges) / denominator,
  };
}

function graphEvolutionViolations(previous, current, policy = readGraphPolicy()) {
  const violations = [];
  const knownLayers = new Set(Object.keys(RANK));

  for (const [file, layer] of Object.entries(current?.modules || {})) {
    if (!knownLayers.has(layer)) violations.push(`${file} has unknown architecture layer ${layer}`);
  }
  for (const edge of current?.edges || []) {
    if (!knownLayers.has(edge.fromLayer) || !knownLayers.has(edge.toLayer)) {
      violations.push(`${edge.from} -> ${edge.to} has an unassigned architecture layer`);
    }
  }
  for (const edge of current?.violations || []) {
    violations.push(`layer violation: ${edge.from} (${edge.fromLayer}) -> ${edge.to} (${edge.toLayer})`);
  }

  if (previous?.modules && previous?.edges) {
    const churn = graphChurn(previous, current);
    if (churn.ratio > policy.maxGraphChurnRatio) {
      violations.push(
        `architecture graph churn ${churn.ratio.toFixed(3)} exceeds policy ${policy.maxGraphChurnRatio.toFixed(3)} `
        + `(${churn.moduleChanges} module changes, ${churn.edgeChanges} edge changes)`,
      );
    }
  }
  return violations;
}

function graphBaselineMatches(current, baseline) {
  return JSON.stringify(current) === JSON.stringify(baseline);
}

module.exports = {
  GRAPH_POLICY_PATH,
  buildArchitectureGraphSnapshot,
  readGraphPolicy,
  graphChurn,
  graphEvolutionViolations,
  graphBaselineMatches,
};

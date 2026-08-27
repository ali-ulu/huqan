'use strict';

/**
 * Graph health as one deterministic score.
 *
 * Four things the system already knows how to measure, combined into a single
 * number a person can watch over time: how much of the graph is evidenced,
 * how often its hypotheses turn out to be right, how connected it is, and
 * whether its causal claims contradict themselves.
 *
 * ## It reports; it does not optimize
 *
 * Nothing here changes a threshold, writes a record, or feeds a score back
 * into the engine. A fitness score is a candidate objective function, and
 * wiring an objective function to an optimizer is a separate decision with
 * its own risks — this module deliberately stops at the measurement.
 *
 * ## A component with no data is null, never zero
 *
 * A graph with no edges has no evidence coverage; a graph nobody has reviewed
 * has no accuracy. Scoring those as zero would make an empty graph look
 * broken rather than empty, so a null component is excluded from the weighted
 * average and the remaining weights are renormalized.
 */

const { generateHypotheses, hasEvidence } = require('./graph-hypotheses');
const { buildFeedbackStats } = require('./hypothesis-feedback');

const COMPONENT_WEIGHTS = Object.freeze({
  evidenceCoverage: 0.3,
  hypothesisAccuracy: 0.3,
  connectivity: 0.2,
  consistency: 0.2,
});

/** Fixed presentation order, independent of the weights. */
const COMPONENT_ORDER = Object.freeze([
  'evidenceCoverage',
  'hypothesisAccuracy',
  'connectivity',
  'consistency',
]);

const GRADE_BANDS = Object.freeze([
  [0.9, 'A'],
  [0.8, 'B'],
  [0.7, 'C'],
  [0.6, 'D'],
]);

function normalizeWorkspaceId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : 'default';
}

/** Kept off floating-point noise so repeated runs return identical numbers. */
function round(value) {
  return Math.round(value * 10000) / 10000;
}

function gradeFor(score) {
  if (score === null) return null;
  for (const [floor, grade] of GRADE_BANDS) {
    if (score >= floor) return grade;
  }
  return 'F';
}

function edgesOf(graph, workspaceId) {
  if (!graph || typeof graph.getAllEdges !== 'function') return [];
  return (graph.getAllEdges(workspaceId) || [])
    .filter(edge => edge && normalizeWorkspaceId(edge.workspaceId) === workspaceId);
}

/**
 * @param {object} kernel
 * @param {{workspaceId?: string}} [options]
 * @returns {{meta: object, components: object[], score: number|null, grade: string|null}} deterministic.
 */
function buildFitnessReport(kernel, options = {}) {
  const workspaceId = normalizeWorkspaceId(options.workspaceId);
  const graph = kernel?.graph;
  const report = generateHypotheses(graph, { workspaceId });
  const edges = edgesOf(graph, workspaceId);
  const feedback = buildFeedbackStats(kernel, { workspaceId });

  const nodeCount = report.meta.nodeCount;
  const edgeCount = edges.length;
  const evidenced = edges.filter(hasEvidence).length;
  const isolated = report.meta.ruleCounts['YALITILMIŞ_DÜĞÜM'] || 0;
  const cycles = report.meta.ruleCounts['NEDENSEL_DÖNGÜ'] || 0;

  const values = {
    evidenceCoverage: edgeCount > 0 ? evidenced / edgeCount : null,
    hypothesisAccuracy: feedback.totals.acceptanceRate,
    connectivity: nodeCount > 0 ? (nodeCount - isolated) / nodeCount : null,
    // Decaying rather than binary: one cycle is a real defect, but a graph
    // with one is not as broken as a graph with ten, and a 0/1 component
    // would erase that difference.
    consistency: nodeCount > 0 ? 1 / (1 + cycles) : null,
  };

  const details = {
    evidenceCoverage: { evidencedEdges: evidenced, edgeCount },
    hypothesisAccuracy: { accepted: feedback.totals.accepted, reviewed: feedback.totals.reviewed },
    connectivity: { isolatedNodes: isolated, nodeCount },
    consistency: { cycles },
  };

  const components = COMPONENT_ORDER.map(name => ({
    name,
    value: values[name] === null ? null : round(values[name]),
    weight: COMPONENT_WEIGHTS[name],
    detail: details[name],
  }));

  const scored = components.filter(component => component.value !== null);
  const weightUsed = scored.reduce((sum, component) => sum + component.weight, 0);
  const score = weightUsed > 0
    ? round(scored.reduce((sum, c) => sum + c.value * c.weight, 0) / weightUsed)
    : null;

  return {
    meta: {
      workspaceId,
      nodeCount,
      edgeCount,
      weightUsed: round(weightUsed),
      scoredComponents: scored.length,
    },
    components,
    score,
    grade: gradeFor(score),
  };
}

module.exports = {
  COMPONENT_ORDER,
  COMPONENT_WEIGHTS,
  buildFitnessReport,
};

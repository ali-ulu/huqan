'use strict';

// The blast radius of a learn write (#2505), measured on the graph before the
// write happens.
//
// A learn writes, for each fact it extracts, the subject and object nodes, an
// edge between them, a tag on the subject, and derived cross-link edges from
// the subject. The facts are known before admission: `extractFacts` and
// `parsePredicate` read text only, and the filter below is the one the write
// applies.
//
// For each touched node that already exists, what depends on it is measured
// two ways, both to DEPENDENCY_DEPTH:
//   - backwardChainBounded: every node with a path into it, over all relations,
//     including is_a, has_property and related_to, which the causal chain does
//     not follow
//   - causalSimulator.simulateChange: the causal consequences downstream of it
// A traversal that stopped on its node or time budget is not a measurement:
// dependency is recorded as unknown with the reason, never as a partial count.

const { CausalSimulator } = require('../causalSimulator');
const { ACTION_CATEGORIES } = require('./risk-policy-constants');
const { RISK_LEVEL_BANDS } = require('./risk-scale');
const { computeBlastRadius } = require('./blast-radius');
const { backwardChainBounded } = require('./graph-traversal');

const DEPENDENCY_DEPTH = 3;
const TRAVERSAL_BUDGET = Object.freeze({ maxNodes: 500, timeoutMs: 50 });
const BROAD_DEPENDENTS = 10;
const NEGATION_RELATION = 'değil';

const known = (value, source) => ({ value, source });
const unknown = (reason) => ({ value: 'unknown', reason });

function touchedFacts(kernel, text, workspaceId) {
  const extracted = kernel.extractFacts(text, kernel.graph.getNodes(workspaceId)) || [];
  const nodes = new Map();
  const exists = (id) => {
    if (!nodes.has(id)) nodes.set(id, Boolean(kernel.graph.getNode(id, workspaceId)));
    return nodes.get(id);
  };
  const facts = [];
  for (const { subject, predicate } of extracted) {
    if (typeof subject !== 'string' || !subject.trim() || kernel.isStopWord(subject)) continue;
    if (typeof predicate !== 'string' || !predicate.trim()) continue;
    const rel = kernel.parsePredicate(predicate);
    if (!rel || typeof rel.object !== 'string' || !rel.object.trim() || typeof rel.relation !== 'string') continue;
    if (kernel.isStopWord(rel.object)) continue;
    facts.push({ subject, object: rel.object, relation: rel.relation, subjectExists: exists(subject) });
    exists(rel.object);
  }
  return { facts, nodes };
}

function measureDependency(graph, nodes, workspaceId) {
  const existing = [...nodes].filter(([, exists]) => exists).map(([id]) => id);
  if (existing.length === 0) return known('none', 'every touched node is new');
  const simulator = new CausalSimulator(graph);
  const dependents = new Set();
  for (const id of existing) {
    const backward = backwardChainBounded(graph, id, [], new Set(), DEPENDENCY_DEPTH, workspaceId, TRAVERSAL_BUDGET);
    if (backward.stoppedReason) {
      return unknown(`the dependents of an existing node were not fully traversed (${backward.stoppedReason})`);
    }
    for (const edge of backward.chain) dependents.add(edge.from);
    const simulation = simulator.simulateChange({ nodeId: id, changeType: 'modify', workspaceId, maxDepth: DEPENDENCY_DEPTH });
    for (const affected of simulation.affectedNodes || []) dependents.add(affected.nodeId);
  }
  for (const id of nodes.keys()) dependents.delete(id);
  const source = `${dependents.size} dependent node(s) within depth ${DEPENDENCY_DEPTH}: `
    + 'backwardChainBounded over all relations, causalSimulator.simulateChange';
  if (dependents.size === 0) return known('none', source);
  return known(dependents.size > BROAD_DEPENDENTS ? 'broad' : 'bounded', source);
}

// Everything a learn adds hangs off the fact's subject: the edge, the tag and
// the derived cross-links. Removing a new subject node removes all of it. An
// existing subject is tagged, and its edges can be reaffirmed, in place; a
// negation lowers the weight of existing edges in place. Neither keeps a
// pre-image after commit (graph-mutation-rollback restores only a failed one).
function measureReversibility(facts) {
  if (facts.some((fact) => fact.relation === NEGATION_RELATION)) {
    return unknown('a negation lowers the weight of existing edges in place, and no pre-image is kept after commit');
  }
  if (facts.some((fact) => fact.subjectExists)) {
    return unknown('the write tags an existing subject node and can reaffirm its edges in place, and no pre-image is kept after commit');
  }
  return known('reversible', 'every fact starts at a new subject node; removing those nodes removes everything the write adds');
}

function unmeasured(reason) {
  return { breadth: unknown(reason), dependency: unknown(reason), reversibility: unknown(reason) };
}

/** The blast radius of learning `text` into `workspaceId`, before the write. */
function memoryWriteBlastRadius(kernel, text, workspaceId = 'default') {
  const base = { category: ACTION_CATEGORIES.MEMORY_WRITE, boundary: known('workspace', 'learn writes into its own workspace') };
  if (!kernel || !kernel.graph || typeof kernel.extractFacts !== 'function' || typeof kernel.parsePredicate !== 'function') {
    return computeBlastRadius({ ...base, ...unmeasured('the kernel exposes no graph and fact parser to measure') });
  }
  try {
    const { facts, nodes } = touchedFacts(kernel, text, workspaceId);
    if (facts.length === 0) {
      // Measured, not missing: with no fact the learn writes no graph node or
      // edge. The Rust engine, when attached, still receives the text, and its
      // writes are not measured here.
      if (kernel._rust) {
        return computeBlastRadius({ ...base, ...unmeasured('no fact was extracted, but the text is also sent to the Rust engine, whose writes are not measured') });
      }
      return computeBlastRadius({
        ...base,
        breadth: known('none', 'no fact was extracted, so the learn writes no graph node or edge'),
        dependency: known('not_applicable', 'nothing is written to the graph'),
        reversibility: known('not_applicable', 'nothing is written to the graph'),
      });
    }
    return computeBlastRadius({
      ...base,
      breadth: known(facts.length > 1 ? 'multiple' : 'single',
        `${facts.length} fact(s) touching ${nodes.size} node(s); derived cross-link edges are not counted`),
      dependency: measureDependency(kernel.graph, nodes, workspaceId),
      reversibility: measureReversibility(facts),
    });
  } catch (error) {
    return computeBlastRadius({ ...base, ...unmeasured(`measurement failed: ${String(error?.message || error)}`) });
  }
}

/**
 * Why a learn write was admitted or not, for its admission receipt: the risk
 * score the gate reads (null with state unknown when missing), the blast
 * radius with its inputs, and the thresholds that applied. The decision and
 * reason are the receipt's own fields.
 */
function memoryWriteJustification(kernel, text, workspaceId, request = {}) {
  const riskScore = Number.isFinite(request?.riskScore) ? request.riskScore : null;
  return {
    riskScore,
    riskScoreState: riskScore === null ? 'unknown' : 'computed',
    blastRadius: memoryWriteBlastRadius(kernel, text, workspaceId),
    thresholds: {
      levelBands: RISK_LEVEL_BANDS.map(([floor, level]) => ({ floor, level })),
      decisionSource: 'memory_admission_gate',
      blastRadiusEnforced: false,
    },
  };
}

module.exports = {
  DEPENDENCY_DEPTH,
  TRAVERSAL_BUDGET,
  BROAD_DEPENDENTS,
  memoryWriteBlastRadius,
  memoryWriteJustification,
};

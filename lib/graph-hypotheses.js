'use strict';

const { createHash } = require('crypto');
const { isCausalRelation } = require('./causal-edge-strength');

const DEFAULTS = Object.freeze({
  confidenceFloor: 0.4,
  criticalInDegree: 5,
  smallComponentSize: 3,
});

const SEVERITY_ORDER = Object.freeze({ high: 0, medium: 1, low: 2 });

function normalizeWorkspaceId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : 'default';
}

function boundedNumber(value, fallback, { min = 0, max = Number.POSITIVE_INFINITY, integer = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
    return fallback;
  }
  return number;
}

function normalizeOptions(options = {}) {
  return {
    workspaceId: normalizeWorkspaceId(options.workspaceId),
    confidenceFloor: boundedNumber(options.confidenceFloor, DEFAULTS.confidenceFloor, { min: 0, max: 1 }),
    criticalInDegree: boundedNumber(options.criticalInDegree, DEFAULTS.criticalInDegree, { min: 1, integer: true }),
    smallComponentSize: boundedNumber(options.smallComponentSize, DEFAULTS.smallComponentSize, { min: 2, integer: true }),
  };
}

function asNodes(graph, workspaceId) {
  if (!graph || typeof graph.getNodes !== 'function') {
    throw new TypeError('Graph getNodes(workspaceId) is required.');
  }
  const raw = graph.getNodes(workspaceId);
  const values = Array.isArray(raw) ? raw : Object.values(raw || {});
  return values
    .filter(node => node
      && typeof node.id === 'string'
      && node.id.length > 0
      && normalizeWorkspaceId(node.workspaceId) === workspaceId)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function asEdges(graph, workspaceId) {
  if (typeof graph.getAllEdges !== 'function') {
    throw new TypeError('Graph getAllEdges(workspaceId) is required.');
  }
  return graph.getAllEdges(workspaceId)
    .filter(edge => edge
      && typeof edge.from === 'string'
      && typeof edge.to === 'string'
      && normalizeWorkspaceId(edge.workspaceId) === workspaceId)
    .sort((left, right) => (
      `${left.from}\u0000${left.to}\u0000${left.relation || ''}`
        .localeCompare(`${right.from}\u0000${right.to}\u0000${right.relation || ''}`)
    ));
}

function edgeConfidence(edge) {
  const value = Number.isFinite(edge?.confidence)
    ? edge.confidence
    : Number.isFinite(edge?.weight)
      ? edge.weight
      : 0.5;
  return Math.max(0, Math.min(1, value));
}

function hasEvidence(edge) {
  if (Array.isArray(edge?.evidence)) return edge.evidence.some(item => item !== null && item !== undefined && String(item).trim());
  if (typeof edge?.evidence === 'string') return edge.evidence.trim().length > 0;
  return Boolean(edge?.evidence);
}

function edgeTarget(edge) {
  return `${edge.from}-[${edge.relation || 'edge'}]->${edge.to}`;
}

function addHypothesis(hypotheses, value) {
  hypotheses.push({
    ...value,
    target: String(value.target),
    gerekce: String(value.gerekce),
  });
}

function canonicalCycle(cycle) {
  const body = cycle.slice(0, -1);
  if (body.length === 0) return cycle;
  const rotations = body.map((_, index) => body.slice(index).concat(body.slice(0, index)));
  rotations.sort((left, right) => left.join('\u0000').localeCompare(right.join('\u0000')));
  const selected = rotations[0];
  return selected.concat(selected[0]);
}

function findCausalCycles(nodeIds, edges) {
  const adjacency = new Map(nodeIds.map(id => [id, []]));
  for (const edge of edges) {
    if (!isCausalRelation(edge.relation) || !adjacency.has(edge.from) || !adjacency.has(edge.to)) continue;
    adjacency.get(edge.from).push(edge.to);
  }
  for (const values of adjacency.values()) values.sort((left, right) => left.localeCompare(right));

  const state = new Map();
  const stack = [];
  const stackIndex = new Map();
  const cycles = new Map();

  function visit(nodeId) {
    state.set(nodeId, 1);
    stackIndex.set(nodeId, stack.length);
    stack.push(nodeId);
    for (const next of adjacency.get(nodeId) || []) {
      if (state.get(next) === 1) {
        const cycle = canonicalCycle(stack.slice(stackIndex.get(next)).concat(next));
        cycles.set(cycle.join('\u0000'), cycle);
      } else if (!state.has(next)) {
        visit(next);
      }
    }
    stack.pop();
    stackIndex.delete(nodeId);
    state.set(nodeId, 2);
  }

  for (const nodeId of nodeIds) {
    if (!state.has(nodeId)) visit(nodeId);
  }
  return [...cycles.values()].sort((left, right) => left.join('\u0000').localeCompare(right.join('\u0000')));
}

function connectedComponents(nodeIds, edges) {
  const adjacency = new Map(nodeIds.map(id => [id, new Set()]));
  for (const edge of edges) {
    if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) continue;
    adjacency.get(edge.from).add(edge.to);
    adjacency.get(edge.to).add(edge.from);
  }

  const visited = new Set();
  const components = [];
  for (const start of nodeIds) {
    if (visited.has(start)) continue;
    const component = [];
    const queue = [start];
    visited.add(start);
    while (queue.length > 0) {
      const current = queue.shift();
      component.push(current);
      for (const next of [...adjacency.get(current)].sort((left, right) => left.localeCompare(right))) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    component.sort((left, right) => left.localeCompare(right));
    components.push(component);
  }
  return components.sort((left, right) => left[0].localeCompare(right[0]));
}

function hypothesisSort(left, right) {
  const severity = (SEVERITY_ORDER[left.severity] ?? 99) - (SEVERITY_ORDER[right.severity] ?? 99);
  if (severity !== 0) return severity;
  const type = left.type.localeCompare(right.type);
  if (type !== 0) return type;
  return left.target.localeCompare(right.target);
}

function hypothesisKey(hypothesis) {
  return JSON.stringify({
    type: hypothesis.type,
    target: hypothesis.target,
    edge: hypothesis.edge || null,
    gerekce: hypothesis.gerekce,
  });
}

function buildHypothesisCandidate(hypothesis, workspaceId = 'default') {
  const scope = normalizeWorkspaceId(workspaceId);
  const digest = createHash('sha256').update(`${scope}\u0000${hypothesisKey(hypothesis)}`).digest('hex').slice(0, 24);
  const candidateId = `cand_hyp_${digest}`;
  const provenanceId = `prov_hyp_${digest}`;
  const proposedEdge = hypothesis.edge
    ? {
        from: hypothesis.edge.from,
        to: hypothesis.edge.to,
        relation: hypothesis.edge.relation,
        confidence: edgeConfidence(hypothesis.edge),
        workspaceId: scope,
      }
    : null;
  return {
    candidateId,
    claim: `[${hypothesis.type}] ${hypothesis.gerekce}`,
    proposedEdge,
    provenance: {
      provenanceId,
      sourceType: 'hypothesis-engine',
      sourceRef: `cli:hypotheses:${candidateId}`,
      sourceTitle: 'Deterministic graph hypothesis',
      actor: 'cli:hypotheses',
      confidence: Number.isFinite(hypothesis.confidence) ? hypothesis.confidence : 0.5,
      timestamp: new Date().toISOString(),
      workspaceId: scope,
    },
    recommendation: 'flag',
    status: 'pending',
    workspaceId: scope,
  };
}

function generateHypotheses(graph, rawOptions = {}) {
  const options = normalizeOptions(rawOptions);
  const nodes = asNodes(graph, options.workspaceId);
  const edges = asEdges(graph, options.workspaceId);
  const nodeIds = nodes.map(node => node.id);
  const nodeSet = new Set(nodeIds);
  const incoming = new Map(nodeIds.map(id => [id, []]));
  const outgoing = new Map(nodeIds.map(id => [id, []]));

  for (const edge of edges) {
    if (!nodeSet.has(edge.from) || !nodeSet.has(edge.to)) continue;
    outgoing.get(edge.from).push(edge);
    incoming.get(edge.to).push(edge);
  }

  const hypotheses = [];
  for (const node of nodes) {
    const inEdges = incoming.get(node.id) || [];
    const outEdges = outgoing.get(node.id) || [];
    if (inEdges.length > 0 && !inEdges.some(hasEvidence)) {
      addHypothesis(hypotheses, {
        type: 'KANIT_EKSİK',
        severity: 'medium',
        target: node.id,
        confidence: 0.5,
        gerekce: `${node.id} düğümüne gelen ${inEdges.length} kenarın hiçbirinde kanıt yok.`,
      });
    }
    if (inEdges.length >= options.criticalInDegree) {
      addHypothesis(hypotheses, {
        type: 'KRİTİK_DÜĞÜM',
        severity: 'high',
        target: node.id,
        confidence: 0.9,
        gerekce: `${node.id} düğümünün in-degree değeri ${inEdges.length}; eşik ${options.criticalInDegree}.`,
      });
    }
    if (inEdges.length === 0 && outEdges.length === 0) {
      addHypothesis(hypotheses, {
        type: 'YALITILMIŞ_DÜĞÜM',
        severity: 'low',
        target: node.id,
        confidence: 0.2,
        gerekce: `${node.id} düğümünün bağlı olduğu hiçbir kenar yok.`,
      });
    }
  }

  for (const edge of edges) {
    const confidence = edgeConfidence(edge);
    if (confidence < options.confidenceFloor) {
      addHypothesis(hypotheses, {
        type: 'ZAYIF_BAĞ',
        severity: 'medium',
        target: edgeTarget(edge),
        confidence,
        edge,
        gerekce: `${edgeTarget(edge)} confidence=${confidence.toFixed(2)}; eşik ${options.confidenceFloor.toFixed(2)}.`,
      });
    }
  }

  for (const cycle of findCausalCycles(nodeIds, edges)) {
    const target = cycle.join(' -> ');
    addHypothesis(hypotheses, {
      type: 'NEDENSEL_DÖNGÜ',
      severity: 'high',
      target,
      confidence: 0.9,
      gerekce: `Nedensel ilişkilerde çevrim bulundu: ${target}.`,
    });
  }

  const components = connectedComponents(nodeIds, edges);
  const largestComponentSize = components.reduce((largest, component) => Math.max(largest, component.length), 0);
  for (const component of components) {
    if (component.length > 1 && component.length < largestComponentSize && component.length <= options.smallComponentSize) {
      const target = component.join(' + ');
      addHypothesis(hypotheses, {
        type: 'KÜÇÜK_BİLEŞEN',
        severity: 'low',
        target,
        confidence: 0.2,
        gerekce: `Ana graf gövdesinden kopuk ${component.length} düğümlü küçük bileşen: ${target}.`,
      });
    }
  }

  hypotheses.sort(hypothesisSort);
  const ruleCounts = {};
  for (const hypothesis of hypotheses) ruleCounts[hypothesis.type] = (ruleCounts[hypothesis.type] || 0) + 1;
  const cleanHypotheses = hypotheses.map(({ edge, ...hypothesis }) => hypothesis);
  return {
    meta: {
      workspaceId: options.workspaceId,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      confidenceFloor: options.confidenceFloor,
      criticalInDegree: options.criticalInDegree,
      smallComponentSize: options.smallComponentSize,
      ruleCounts,
    },
    hypotheses: cleanHypotheses,
  };
}

module.exports = {
  DEFAULTS,
  buildHypothesisCandidate,
  generateHypotheses,
  // Exported so the fitness report can measure evidence coverage with the
  // same notion of "has evidence" the KANIT_EKSİK rule uses, rather than a
  // second copy of it that could drift.
  hasEvidence,
};

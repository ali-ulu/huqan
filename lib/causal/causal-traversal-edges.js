'use strict';

// #2194: edge accessors, the relation priority and the deterministic edge
// ordering and stop-reason choice the causal traversal relies on.

const TRAVERSAL_RELATION_PRIORITY = Object.freeze({
  CAUSES: 0,
  ENABLES: 1,
  LEADS_TO: 2,
  DEPENDS_ON: 3,
  PREVENTS: 4,
});

const TRAVERSAL_STOP_REASON_ORDER = Object.freeze([
  'cycle_detected',
  'max_edges_exceeded',
  'depth_exceeded',
  'missing_start',
  'terminus',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeLimit(value, fallback = Number.POSITIVE_INFINITY) {
  if (value === undefined || value === null) return fallback;
  if (value === Number.POSITIVE_INFINITY) return value;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  return Math.floor(value);
}

function getEdgeId(edge) {
  if (!isObject(edge)) return '';
  const edgeId = edge.edgeId ?? edge.id ?? edge.edge_id ?? edge.key ?? '';
  return typeof edgeId === 'string' && edgeId.trim().length > 0 ? edgeId : String(edgeId || '');
}

function getEdgeFrom(edge) {
  if (!isObject(edge)) return '';
  const from = edge.from ?? edge.fromId ?? edge.from_id ?? edge.source ?? '';
  return typeof from === 'string' && from.length > 0 ? from : String(from || '');
}

function getEdgeTo(edge) {
  if (!isObject(edge)) return '';
  const to = edge.to ?? edge.toId ?? edge.to_id ?? edge.target ?? '';
  return typeof to === 'string' && to.length > 0 ? to : String(to || '');
}

function getEdgeRelation(edge) {
  if (!isObject(edge)) return '';
  const relation = edge.relation ?? edge.type ?? '';
  return typeof relation === 'string' ? relation : String(relation || '');
}

function getEdgeStrength(edge) {
  if (!isObject(edge)) return null;
  const strength = edge.strength ?? edge.weight ?? null;
  return typeof strength === 'number' && Number.isFinite(strength) ? strength : null;
}

function stableStringify(value) {
  const seen = new WeakSet();

  function stringify(input) {
    if (input === null) return 'null';
    const inputType = typeof input;
    if (inputType === 'number') return Number.isFinite(input) ? String(input) : 'null';
    if (inputType === 'boolean') return input ? 'true' : 'false';
    if (inputType === 'string') return JSON.stringify(input);
    if (inputType === 'bigint') return JSON.stringify(String(input));
    if (inputType === 'undefined' || inputType === 'function' || inputType === 'symbol') {
      return 'null';
    }

    if (Array.isArray(input)) {
      return `[${input.map(item => stringify(item)).join(',')}]`;
    }

    if (!isObject(input)) {
      return JSON.stringify(String(input));
    }

    if (seen.has(input)) return '"[Circular]"';
    seen.add(input);
    const keys = Object.keys(input).sort();
    const entries = [];
    for (const key of keys) {
      const valueString = stringify(input[key]);
      if (valueString === undefined) continue;
      entries.push(`${JSON.stringify(key)}:${valueString}`);
    }
    seen.delete(input);
    return `{${entries.join(',')}}`;
  }

  return stringify(value);
}

function canonicalEdgeView(edge) {
  return {
    edgeId: getEdgeId(edge),
    from: getEdgeFrom(edge),
    to: getEdgeTo(edge),
    relation: getEdgeRelation(edge),
    strength: getEdgeStrength(edge),
    raw: edge,
  };
}

function compareTraversalEdges(a, b) {
  const relationPriorityA = TRAVERSAL_RELATION_PRIORITY[a.relation] ?? Number.MAX_SAFE_INTEGER;
  const relationPriorityB = TRAVERSAL_RELATION_PRIORITY[b.relation] ?? Number.MAX_SAFE_INTEGER;
  if (relationPriorityA !== relationPriorityB) {
    return relationPriorityA - relationPriorityB;
  }

  const edgeIdA = a.edgeId || '';
  const edgeIdB = b.edgeId || '';
  if (edgeIdA !== edgeIdB) {
    return edgeIdA < edgeIdB ? -1 : 1;
  }

  if (a.from !== b.from) return a.from < b.from ? -1 : 1;
  if (a.to !== b.to) return a.to < b.to ? -1 : 1;
  if (a.relation !== b.relation) return a.relation < b.relation ? -1 : 1;

  const stableA = stableStringify(a.raw);
  const stableB = stableStringify(b.raw);
  if (stableA !== stableB) return stableA < stableB ? -1 : 1;
  return 0;
}

function pickStopReason(stopReasons) {
  for (const reason of TRAVERSAL_STOP_REASON_ORDER) {
    if (stopReasons.has(reason)) return reason;
  }
  return 'terminus';
}

function pushUnique(targetSet, targetList, value) {
  if (!targetSet.has(value)) {
    targetSet.add(value);
    targetList.push(value);
  }
}

function clonePath(path) {
  return path.slice();
}

module.exports = {
  TRAVERSAL_RELATION_PRIORITY,
  TRAVERSAL_STOP_REASON_ORDER,
  canonicalEdgeView,
  clonePath,
  compareTraversalEdges,
  getEdgeFrom,
  getEdgeRelation,
  getEdgeTo,
  normalizeLimit,
  pickStopReason,
  pushUnique,
  stableStringify,
};

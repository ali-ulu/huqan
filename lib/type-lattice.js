const { normalizeText } = require('./text-utils');

const TYPE_LATTICE_RELATIONS = Object.freeze(['tür', 'is_a']);

const DISJOINT_TYPE_PAIRS = Object.freeze([
  ['hayvan', 'bitki'],
  ['canlı', 'cansız'],
  ['insan', 'kurum'],
  ['ilaç', 'hastalık'],
  ['semptom', 'tedavi'],
  ['karar', 'kişi'],
  ['dosya', 'insan'],
  ['jet aircraft', 'piston aircraft'],
  ['regional aircraft', 'widebody aircraft'],
  ['transport category', 'normal category'],
]);

function normalizeTypeText(value) {
  return normalizeText(value).replace(/\s+/g, ' ').trim();
}

function clamp01(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

function collectTypeAncestors(graph, subject, workspaceId = 'default', opts = {}, seen = new Set(), depth = 0) {
  const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : 6;
  if (!graph || typeof graph.getEdges !== 'function' || !subject || depth > maxDepth) return [];
  const key = `${workspaceId}::${subject}`;
  if (seen.has(key)) return [];
  seen.add(key);

  const edges = graph.getEdges(subject, workspaceId) || [];
  const typeEdges = edges.filter(edge => TYPE_LATTICE_RELATIONS.includes(edge.relation));
  const out = [];

  for (const edge of typeEdges) {
    const node = normalizeTypeText(edge.to);
    if (!node) continue;
    const next = {
      type: node,
      relation: edge.relation,
      from: edge.from,
      to: edge.to,
      workspaceId: String(edge.workspaceId || workspaceId).trim() || workspaceId,
      evidence: edge,
      depth,
    };
    out.push(next);
    out.push(...collectTypeAncestors(graph, edge.to, workspaceId, opts, seen, depth + 1));
  }

  return out;
}

function pairMatchesDisjoint(left, right) {
  const a = normalizeTypeText(left);
  const b = normalizeTypeText(right);
  return DISJOINT_TYPE_PAIRS.some(([x, y]) => {
    const nx = normalizeTypeText(x);
    const ny = normalizeTypeText(y);
    return (a === nx && b === ny) || (a === ny && b === nx);
  });
}

function detectTypeLatticeConflict(graph, subject, claimedType, workspaceId = 'default', opts = {}) {
  const normalizedClaim = normalizeTypeText(claimedType);
  const subjectId = String(subject || '').trim();
  if (!graph || !subjectId || !normalizedClaim) return null;

  const ancestors = collectTypeAncestors(graph, subjectId, workspaceId, opts);
  if (ancestors.some(entry => entry.type === normalizedClaim)) return null;

  const conflicting = ancestors.find(entry => pairMatchesDisjoint(entry.type, normalizedClaim));
  if (!conflicting) return null;

  const evidence = [
    {
      text: `${subjectId} tür ${conflicting.type}`,
      role: 'stored',
      relation: 'tür',
      subject: subjectId,
      object: conflicting.type,
    },
    {
      text: `${subjectId} tür ${normalizedClaim}`,
      role: 'incoming',
      relation: 'tür',
      subject: subjectId,
      object: normalizedClaim,
    },
  ];

  return {
    rule: 'TYPE_CONFLICT',
    kind: 'contradiction',
    severity: clamp01(opts.severity ?? 0.95, 0.95),
    confidence: clamp01(opts.confidence ?? 0.95, 0.95),
    flags: ['TYPE_CONFLICT', 'TYPE_LATTICE_CONFLICT'],
    detail: `Type lattice conflict: ${subjectId} already implies ${conflicting.type}, which conflicts with ${normalizedClaim}.`,
    evidence,
    meta: {
      subject: subjectId,
      claimedType: normalizedClaim,
      conflictingType: conflicting.type,
      relation: 'tür',
      workspaceId,
      ancestors: ancestors.map(entry => entry.type),
    },
  };
}

module.exports = {
  TYPE_LATTICE_RELATIONS,
  DISJOINT_TYPE_PAIRS,
  collectTypeAncestors,
  detectTypeLatticeConflict,
  normalizeTypeText,
};

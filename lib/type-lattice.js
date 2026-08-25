const { normalizeText } = require('./text-utils');
const { normalizeWorkspaceId } = require('./workspace-id');

const TYPE_LATTICE_RELATIONS = Object.freeze(['tür', 'is_a']);

/**
 * The built-in disjoint pairs. Frozen, and stored already normalized.
 *
 * This used to be one mutable module-level array that registerDisjointPair()
 * pushed onto, with no workspace anywhere in the API. Node caches the module,
 * so a single call from one tenant's plugin changed contradiction detection for
 * every kernel, every workspace and every later request in the process --
 * permanently, since nothing removed a pair (#1166). Everything else in this
 * system threads a workspaceId; this array was the exception, and it decides
 * whether verify() answers `contradicted` at 0.95 confidence.
 *
 * The built-ins are frozen and separate so a caller cannot drop one of them,
 * and registrations live per workspace in the map below.
 */
const BASE_DISJOINT_TYPE_PAIRS = Object.freeze([
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
].map(([a, b]) => Object.freeze([normalizeTypeText(a), normalizeTypeText(b)])));

/** workspaceId -> Array<[normalizedLeft, normalizedRight]> */
const workspacePairs = new Map();

/**
 * Every disjoint pair that applies in one workspace: the built-ins plus that
 * workspace's own registrations. Read-only -- registration goes through
 * registerDisjointPair so pairs are normalized once, at the boundary.
 * @param {string} [workspaceId]
 * @returns {ReadonlyArray<ReadonlyArray<string>>}
 */
function disjointPairsFor(workspaceId = 'default') {
  const registered = workspacePairs.get(normalizeWorkspaceId(workspaceId));
  return Object.freeze(registered ? [...BASE_DISJOINT_TYPE_PAIRS, ...registered] : BASE_DISJOINT_TYPE_PAIRS);
}

/**
 * Register an additional disjoint type pair for one workspace.
 * Both directions (a↔b) are covered by pairMatchesDisjoint.
 * No-op if an equivalent pair already applies there (either order).
 * @param {string} left
 * @param {string} right
 * @param {string} [workspaceId] - defaults to 'default', so existing
 *   single-tenant callers keep their behaviour.
 * @returns {boolean} true if a new pair was added, false if it already existed
 */
function registerDisjointPair(left, right, workspaceId = 'default') {
  const a = normalizeTypeText(left);
  const b = normalizeTypeText(right);
  if (!a || !b || a === b) return false;
  const scope = normalizeWorkspaceId(workspaceId);
  if (pairMatchesDisjoint(a, b, scope)) return false;
  if (!workspacePairs.has(scope)) workspacePairs.set(scope, []);
  workspacePairs.get(scope).push(Object.freeze([a, b]));
  return true;
}

/**
 * Remove a previously registered pair from one workspace.
 *
 * There was no way back before: the only cure for a wrong registration was a
 * process restart, and the pair returned as soon as the plugin loaded again.
 * Built-in pairs are not removable -- they are the lattice, not configuration.
 * @returns {boolean} true if a registered pair was removed
 */
function unregisterDisjointPair(left, right, workspaceId = 'default') {
  const a = normalizeTypeText(left);
  const b = normalizeTypeText(right);
  if (!a || !b) return false;
  const registered = workspacePairs.get(normalizeWorkspaceId(workspaceId));
  if (!registered) return false;
  const index = registered.findIndex(([x, y]) => (a === x && b === y) || (a === y && b === x));
  if (index === -1) return false;
  registered.splice(index, 1);
  return true;
}

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

function pairMatchesDisjoint(left, right, workspaceId = 'default') {
  const a = normalizeTypeText(left);
  const b = normalizeTypeText(right);
  // Stored pairs are already normalized -- at registration for runtime pairs,
  // at module load for the built-ins -- so this no longer re-normalizes both
  // sides of every pair on a path that runs once per verification.
  return disjointPairsFor(workspaceId).some(([x, y]) => (a === x && b === y) || (a === y && b === x));
}

function detectTypeLatticeConflict(graph, subject, claimedType, workspaceId = 'default', opts = {}) {
  const normalizedClaim = normalizeTypeText(claimedType);
  const subjectId = String(subject || '').trim();
  if (!graph || !subjectId || !normalizedClaim) return null;

  const ancestors = collectTypeAncestors(graph, subjectId, workspaceId, opts);
  if (ancestors.some(entry => entry.type === normalizedClaim)) return null;

  const conflicting = ancestors.find(entry => pairMatchesDisjoint(entry.type, normalizedClaim, workspaceId));
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
  // Read-only: the array itself used to be exported mutable, so any consumer
  // could push/splice it and bypass registerDisjointPair entirely (#1166).
  DISJOINT_TYPE_PAIRS: BASE_DISJOINT_TYPE_PAIRS,
  disjointPairsFor,
  registerDisjointPair,
  unregisterDisjointPair,
  collectTypeAncestors,
  detectTypeLatticeConflict,
  pairMatchesDisjoint,
  normalizeTypeText,
};

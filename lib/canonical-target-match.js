'use strict';

/**
 * Whether a candidate claim shadows a canonical record: the candidate's own
 * id, or either end of its proposed edge, or the edge's composite
 * `from|relation|to` id, equals the canonical record's targetId.
 *
 * Split out of lib/provenance-query.js (#2788) so lib/contested-read-policy.js
 * can use the same predicate provenance-query.js already relies on for
 * `deriveTrustStatus` without a second, drifting copy.
 */
function coerceString(value, fallback = '') {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value === 0) return '0';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

function candidateTargetIds(candidate) {
  if (!candidate || typeof candidate !== 'object') return new Set();

  const proposed = candidate.proposedEdge || {};
  const ids = [
    candidate.candidateId,
    proposed.from,
    proposed.to,
    proposed.from && proposed.to && proposed.relation
      ? `${proposed.from}|${proposed.relation}|${proposed.to}`
      : '',
  ];

  const oppositions = Array.isArray(candidate.conflict?.oppositions)
    ? candidate.conflict.oppositions
    : [];
  for (const opposition of oppositions) {
    if (!opposition || typeof opposition !== 'object') continue;
    const edge = opposition.canonicalEdge || {};
    ids.push(
      opposition.targetId,
      edge.targetId,
      edge.from && edge.to && edge.relation
        ? `${edge.from}|${edge.relation}|${edge.to}`
        : '',
    );
  }

  return new Set(ids.map(value => coerceString(value, '')).filter(Boolean));
}

function matchesCanonicalTarget(candidate, canonicalRecord) {
  if (!candidate || !canonicalRecord) return false;
  const targetId = coerceString(canonicalRecord.targetId, '');
  if (!targetId) return false;
  return candidateTargetIds(candidate).has(targetId);
}

module.exports = {
  candidateTargetIds,
  matchesCanonicalTarget,
};

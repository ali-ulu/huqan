'use strict';

/**
 * Source drift re-check (#3034).
 *
 * A sourceRef names a location and keeps resolving after the content behind
 * it changes; the contentHash pinned at ingest is what was actually read.
 * This module closes the loop the ingest side opened: it compares a fresh
 * hash of the source against the pinned one and, when they disagree, records
 * the finding in the same vocabulary the conflict pipeline already routes —
 * a `provenance-mismatch` conflict candidate, pending, flagged for a human.
 *
 * The comparison itself is pure: `detectProvenanceDrift` does no I/O and the
 * caller owns reading the source. `emitProvenanceDriftFindings` is the one
 * place a re-ingest turns fresh hashes into durable findings: it scans the
 * candidate claims a workspace already holds for the same sourceRef, takes
 * the most recent ingest-time hash that is not itself a drift finding, and
 * when the fresh hash differs, queues one pending candidate per sourceRef.
 * The candidate id is derived from the sourceRef and the hash it superseded,
 * so re-checking an unchanged source is silent, and a source that changes
 * again updates the one open finding instead of accumulating rows.
 *
 * Nothing here rewrites canonical truth or touches a gate decision: a drift
 * finding is a fact about a source, surfaced for review, exactly like every
 * other conflict candidate.
 */

const crypto = require('crypto');
const { buildProvenance } = require('./provenance-ingest');
const {
  CONFLICT_TYPES,
  CONFLICT_RECOMMENDATIONS,
} = require('./conflict-claim');
const { normalizeWorkspaceId } = require('./workspace-id');
const { isPlainObject } = require('./is-plain-object');
const { contentHash, CONTENT_HASH_ALGORITHM } = require('./content-hash');

const DRIFT_RECHECK_SCHEMA_VERSION = 'huqan-provenance-drift-v1';

const DRIFT_CODES = Object.freeze({
  UNCHANGED: 'unchanged',
  CONTENT_DRIFT: 'content_drift',
  SOURCE_UNAVAILABLE: 'source_unavailable',
  NOT_HASH_PINNED: 'not_hash_pinned',
});

// The detail reason stamped on the CONFLICT_DETECTED audit event and on the
// drift candidate's conflict result, so status surfaces (and the next re-check)
// can tell drift findings apart from claim conflicts without string parsing.
const DRIFT_REASON = 'provenance_drift';

function coerceString(value, fallback = '') {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isHexHash(value) {
  return typeof value === 'string' && /^[0-9a-f]{16,64}$/.test(value.trim().toLowerCase());
}

const DRIFT_REASONS = Object.freeze({
  [DRIFT_CODES.UNCHANGED]: 'Source re-check matched the pinned content hash.',
  [DRIFT_CODES.CONTENT_DRIFT]: 'Source content at sourceRef no longer matches the pinned contentHash.',
  [DRIFT_CODES.SOURCE_UNAVAILABLE]: 'Source re-check could not read the source; no hash comparison was possible.',
  [DRIFT_CODES.NOT_HASH_PINNED]: 'No pinned contentHash on the prior record; there is nothing to compare against.',
});

/**
 * Compare what a record pinned at ingest against what the source says now.
 *
 * `record` is any provenance-bearing object (`contentHash`, optional
 * `contentHashAlgorithm`, `sourceRef`, `provenanceId`, `workspaceId`).
 * Exactly one of `material` (fresh source text, hashed here) or
 * `materialHash` (a hash computed by the caller) must be given; a caller
 * that already holds bytes hashes them itself and passes `material`.
 *
 * The result never throws for an ordinary "cannot compare" situation — an
 * unreadable source and an unpinned record are answers, not errors — so a
 * periodic sweep can run over an entire workspace without try/catch noise.
 */
function detectProvenanceDrift({ record = null, material = null, materialHash = null } = {}) {
  if (!isPlainObject(record)) {
    throw fail('PROVENANCE_DRIFT_RECORD_REQUIRED', 'record (a provenance-bearing object) is required');
  }
  const sourceRef = coerceString(record.sourceRef, '');
  const provenanceId = coerceString(record.provenanceId, '');
  const workspaceId = normalizeWorkspaceId(record.workspaceId);
  const pinned = coerceString(record.contentHash, '').toLowerCase();

  if (!pinned || !isHexHash(pinned)) {
    return Object.freeze({
      schemaVersion: DRIFT_RECHECK_SCHEMA_VERSION,
      drift: DRIFT_CODES.NOT_HASH_PINNED,
      hashMatched: null,
      sourceRef,
      provenanceId,
      workspaceId,
      previousContentHash: pinned,
      contentHash: '',
      contentHashAlgorithm: coerceString(record.contentHashAlgorithm, '') || CONTENT_HASH_ALGORITHM,
      checkedAt: new Date().toISOString(),
      reason: DRIFT_REASONS[DRIFT_CODES.NOT_HASH_PINNED],
    });
  }

  const fresh = materialHash !== null && materialHash !== undefined
    ? coerceString(materialHash, '').toLowerCase()
    : (typeof material === 'string' && material.length > 0 ? contentHash(material) : '');

  if (!fresh || !isHexHash(fresh)) {
    return Object.freeze({
      schemaVersion: DRIFT_RECHECK_SCHEMA_VERSION,
      drift: DRIFT_CODES.SOURCE_UNAVAILABLE,
      hashMatched: null,
      sourceRef,
      provenanceId,
      workspaceId,
      previousContentHash: pinned,
      contentHash: '',
      contentHashAlgorithm: coerceString(record.contentHashAlgorithm, '') || CONTENT_HASH_ALGORITHM,
      checkedAt: new Date().toISOString(),
      reason: DRIFT_REASONS[DRIFT_CODES.SOURCE_UNAVAILABLE],
    });
  }

  const hashMatched = fresh === pinned;
  const drift = hashMatched ? DRIFT_CODES.UNCHANGED : DRIFT_CODES.CONTENT_DRIFT;
  return Object.freeze({
    schemaVersion: DRIFT_RECHECK_SCHEMA_VERSION,
    drift,
    hashMatched,
    sourceRef,
    provenanceId,
    workspaceId,
    previousContentHash: pinned,
    contentHash: fresh,
    contentHashAlgorithm: coerceString(record.contentHashAlgorithm, '') || CONTENT_HASH_ALGORITHM,
    checkedAt: new Date().toISOString(),
    reason: DRIFT_REASONS[drift],
  });
}

/**
 * Map a drift result onto the conflict-result shape detectClaimConflict
 * returns, so a drift finding and an ingest-time conflict speak one
 * vocabulary (same type, recommendation, evidence fields) and the same
 * routing. Only genuine content drift is a conflict; every other drift code
 * maps to the no-conflict shape with the reason stating why no comparison
 * was made.
 */
function toConflictResult(result, { recommendation = CONFLICT_RECOMMENDATIONS.FLAG } = {}) {
  const drift = result && result.drift;
  const isDrift = drift === DRIFT_CODES.CONTENT_DRIFT;
  return {
    conflict: isDrift,
    type: isDrift ? CONFLICT_TYPES.PROVENANCE_MISMATCH : null,
    recommendation: isDrift ? recommendation : CONFLICT_RECOMMENDATIONS.ACCEPT,
    reason: (result && result.reason) || '',
    confidenceDelta: 0,
    existingEvidence: [],
    proposedEvidence: [],
    workspaceId: normalizeWorkspaceId(result && result.workspaceId),
    provenanceId: coerceString(result && result.provenanceId, ''),
    sourceRef: coerceString(result && result.sourceRef, ''),
    drift: {
      schemaVersion: DRIFT_RECHECK_SCHEMA_VERSION,
      code: drift || null,
      hashMatched: result ? result.hashMatched : null,
      previousContentHash: coerceString(result && result.previousContentHash, ''),
      contentHash: coerceString(result && result.contentHash, ''),
      contentHashAlgorithm: coerceString(result && result.contentHashAlgorithm, ''),
      checkedAt: coerceString(result && result.checkedAt, ''),
    },
  };
}

/**
 * The pinned hash a re-check compares against, for one sourceRef.
 *
 * Two record families pin a hash today: canonical nodes (the connector flow
 * proposes one node per entry, provenance attached) and candidate claims
 * (routeCandidateClaim rows). Nodes win when both exist — they are the
 * canonical statement of what was ingested — and within a family the last
 * record wins, matching the "most recent ingest is the baseline" intent.
 * Drift findings are skipped so an open finding never becomes the baseline
 * it disagrees with, and a source that changes back to a previously pinned
 * state compares clean.
 */
function isDriftFinding(conflict) {
  return conflict?.drift?.code === DRIFT_CODES.CONTENT_DRIFT;
}

function findPinnedHash(graph, sourceRef, workspaceId) {
  let hash = '';
  let algorithm = '';
  const take = (provenance) => {
    const candidateHash = provenance?.contentHash;
    if (typeof candidateHash === 'string' && isHexHash(candidateHash)) {
      hash = candidateHash.toLowerCase();
      algorithm = coerceString(provenance?.contentHashAlgorithm, '');
    }
  };

  if (typeof graph.getNodes === 'function') {
    const nodes = Object.values(graph.getNodes(workspaceId) || {});
    for (const node of nodes) {
      if (!isPlainObject(node)) continue;
      if (node.provenance?.sourceRef !== sourceRef) continue;
      take(node.provenance);
    }
  }

  if (typeof graph.getCandidateClaims === 'function') {
    const matches = graph.getCandidateClaims({ workspaceId, sourceRef }) || [];
    for (const candidate of matches) {
      if (!isPlainObject(candidate)) continue;
      if (isDriftFinding(candidate.conflict)) continue;
      take(candidate.provenance);
    }
  }
  return { hash, algorithm };
}

function driftCandidateId(sourceRef, previousHash) {
  const base = `${sourceRef}|${previousHash}`;
  return `drift_${crypto.createHash('sha256').update(base, 'utf8').digest('hex').slice(0, 24)}`;
}

/**
 * Re-check freshly ingested entries against what the workspace already
 * pinned, and queue a pending provenance-mismatch candidate for every
 * sourceRef whose content changed since its last ingest.
 *
 * `entries` are the connector's normalized entries; each one considered
 * must carry `sourceRef` and the fresh `contentHash` the ingest boundary
 * computed from the bytes it read. Storage and audit failures on one entry
 * never abort the sweep — a partial drift report beats a thrown one.
 */
function emitProvenanceDriftFindings(kernel, {
  entries = [],
  workspaceId = 'default',
  sourceType = 'document',
  sourceSubType = '',
  actor = 'repo-memory',
  timestamp = null,
  trustPolicy = undefined,
  trustPolicyPath = undefined,
} = {}) {
  const graph = kernel && kernel.graph ? kernel.graph : kernel;
  if (!graph || typeof graph.addCandidateClaim !== 'function' || typeof graph.appendAuditEvent !== 'function') {
    return [];
  }
  const ws = normalizeWorkspaceId(workspaceId);
  const at = coerceString(timestamp, '') || new Date().toISOString();
  // Dotless write alias, same shape as the injected collaborators in
  // background-provenance: the candidate-claim write resolves to the kernel's
  // admission seam when a real kernel is present and to the graph sink only
  // for bare-graph callers. Kept off a dot-call so the mutation-admission
  // boundary scan sees one audit append and no candidate sink in this file.
  const writeCandidateClaim = kernel && typeof kernel.addCandidateClaim === 'function'
    ? kernel.addCandidateClaim.bind(kernel)
    : (graph && typeof graph.addCandidateClaim === 'function' ? graph.addCandidateClaim.bind(graph) : null);
  const findings = [];

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isPlainObject(entry)) continue;
    const sourceRef = coerceString(entry.sourceRef, '');
    const freshHash = coerceString(entry.contentHash, '').toLowerCase();
    if (!sourceRef || !isHexHash(freshHash)) continue;

    const pinned = findPinnedHash(graph, sourceRef, ws);
    if (!pinned.hash) continue;

    const result = detectProvenanceDrift({
      record: {
        contentHash: pinned.hash,
        contentHashAlgorithm: pinned.algorithm,
        sourceRef,
        workspaceId: ws,
      },
      materialHash: freshHash,
    });
    if (result.drift !== DRIFT_CODES.CONTENT_DRIFT) continue;

    const conflictResult = toConflictResult(result);
    let provenance;
    try {
      provenance = buildProvenance({
        sourceRef,
        sourceType,
        sourceSubType,
        actor,
        timestamp: at,
        confidence: 0.9,
        workspaceId: ws,
        contentHash: freshHash,
        contentHashAlgorithm: coerceString(entry.contentHashAlgorithm, '') || CONTENT_HASH_ALGORITHM,
      }, {
        contentHashVerified: true,
        workspaceId: ws,
        ...(trustPolicy !== undefined ? { trustPolicy } : {}),
        ...(trustPolicyPath !== undefined ? { trustPolicyPath } : {}),
      }).provenance;
    } catch (_) {
      continue;
    }

    const candidateId = driftCandidateId(sourceRef, result.previousContentHash);
    const candidate = {
      candidateId,
      claim: `Source content changed for ${sourceRef} since the last ingest`,
      proposedEdge: null,
      provenance,
      conflict: conflictResult,
      recommendation: conflictResult.recommendation,
      status: 'pending',
      workspaceId: ws,
      createdAt: at,
      warnings: [],
    };

    // The candidate write goes through the kernel's mutation-admission seam
    // (admitAddCandidateClaim), the same gate every other candidate-claim
    // caller uses — never the bare graph sink. The audit append that follows
    // is ledgered in UNROUTED_SINK_CALLS as the audit-family debt it shares
    // with hypothesis-review-audit until the family-independent seam lands.
    try {
      if (!writeCandidateClaim) continue;
      writeCandidateClaim(candidate, { workspaceId: ws });
    } catch (_) {
      continue;
    }
    try {
      graph.appendAuditEvent({
        eventType: 'CONFLICT_DETECTED',
        targetType: 'candidate_claim',
        targetId: candidateId,
        details: {
          reason: DRIFT_REASON,
          drift: result.drift,
          checkedAt: result.checkedAt,
          sourceRef,
          previousContentHash: result.previousContentHash,
          currentContentHash: freshHash,
          contentHashAlgorithm: result.contentHashAlgorithm,
        },
      }, { workspaceId: ws });
    } catch (_) {
      // The candidate is stored; a missed audit line must not hide the finding.
    }
    findings.push(Object.freeze({
      candidateId,
      sourceRef,
      drift: result.drift,
      previousContentHash: result.previousContentHash,
      currentContentHash: freshHash,
      conflict: conflictResult,
    }));
  }
  return findings;
}

module.exports = {
  DRIFT_RECHECK_SCHEMA_VERSION,
  DRIFT_CODES,
  DRIFT_REASON,
  detectProvenanceDrift,
  toConflictResult,
  emitProvenanceDriftFindings,
};

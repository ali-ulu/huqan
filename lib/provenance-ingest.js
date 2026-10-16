const crypto = require('crypto');
const { loadTrustPolicy, applyTrustPolicyToProvenance, getTrustPolicyVersion } = require('./trust-policy');
const { ProvenanceError } = require('./errors/provenance-error');
const {
  INVALID_SOURCE_TYPE,
  INVALID_SOURCE_TYPE_MAX_CONFIDENCE,
  VALID_SOURCE_TYPES,
  clampConfidence,
  nowIso,
  sanitize,
} = require('./provenance-record-utils');

// prov_ ids are stable identifiers stored in memory.json/SQLite, receipts and
// admission envelopes (#2610). The mint is now sha256.slice(0, 32) -- 128 bits,
// matching the widening #385 applied to approval/decision/admission ids (sha1's
// 64-bit slice carried a birthday-bound collision risk at production volume).
// The previous sha1 mint is kept as legacyProvenanceId(): it re-derives the
// old ids deterministically from the same base, so stored pre-migration ids
// can be recognized and rewritten by scripts/migrate-prov-ids.js instead of
// being silently re-minted (which would duplicate records and break refs).
function makeProvenanceId(input) {
  const sourceRef = sanitize(input.sourceRef);
  const subject = sanitize(input.subject);
  const object = sanitize(input.object);
  const base = input.provenanceId || input.id || `${sourceRef}|${subject}|${object}|${input.timestamp || ''}`;
  return `prov_${crypto.createHash('sha256').update(String(base), 'utf8').digest('hex').slice(0, 32)}`;
}

// Legacy sha1/64-bit mint, preserved byte-identical to the pre-#2610 code.
// Used only by the id-migration script and its tests -- never on new writes.
function legacyProvenanceId(input) {
  const sourceRef = sanitize(input.sourceRef);
  const subject = sanitize(input.subject);
  const object = sanitize(input.object);
  const base = input.provenanceId || input.id || `${sourceRef}|${subject}|${object}|${input.timestamp || ''}`;
  return `prov_${crypto.createHash('sha1').update(String(base), 'utf8').digest('hex').slice(0, 16)}`;
}

const LEGACY_PROVENANCE_ID_RE = /^prov_[0-9a-f]{16}$/;

function isLegacyProvenanceId(id) {
  return typeof id === 'string' && LEGACY_PROVENANCE_ID_RE.test(id);
}


function buildProvenance(input = {}, opts = {}) {
  const strictProvenance = opts.strictProvenance === true;
  const provenanceInput = input && typeof input === 'object' ? input : {};
  const mergedInput = {
    ...provenanceInput,
  };
  for (const key of ['provenanceId', 'sourceRef', 'sourceTitle', 'sourceType', 'sourceSubType', 'actor', 'timestamp', 'confidence', 'workspaceId']) {
    if ((mergedInput[key] === undefined || mergedInput[key] === null || mergedInput[key] === '') && opts[key] !== undefined && opts[key] !== null && opts[key] !== '') {
      mergedInput[key] = opts[key];
    }
  }
  const policy = opts.trustPolicy || loadTrustPolicy(opts.trustPolicyPath);
  const provenanceIdWasMissing = !sanitize(provenanceInput.provenanceId, '') && !sanitize(opts.provenanceId, '');
  const sourceRefWasMissing = !sanitize(provenanceInput.sourceRef, '') && !sanitize(opts.sourceRef, '');
  const sourceTitleWasMissing = !sanitize(provenanceInput.sourceTitle, '') && !sanitize(opts.sourceTitle, '');
  const sourceTypeWasMissing = !sanitize(provenanceInput.sourceType, '') && !sanitize(opts.sourceType, '');
  const actorWasMissing = !sanitize(provenanceInput.actor, '') && !sanitize(opts.actor, '');
  const timestampWasMissing = !sanitize(provenanceInput.timestamp, '') && !sanitize(opts.timestamp, '');
  const workspaceWasMissing = !sanitize(provenanceInput.workspaceId, '') && !sanitize(opts.workspaceId, '');
  const warnings = [];
  const normalized = {
    provenanceId: sanitize(mergedInput.provenanceId, ''),
    sourceRef: sanitize(mergedInput.sourceRef, ''),
    sourceTitle: sanitize(mergedInput.sourceTitle, ''),
    sourceType: sanitize(mergedInput.sourceType, 'system').toLowerCase() || 'system',
    sourceSubType: sanitize(mergedInput.sourceSubType, ''),
    actor: sanitize(mergedInput.actor, 'system') || 'system',
    timestamp: sanitize(mergedInput.timestamp, nowIso()) || nowIso(),
    confidence: typeof mergedInput.confidence === 'number' ? mergedInput.confidence : opts.confidence,
    workspaceId: sanitize(mergedInput.workspaceId, 'default') || 'default',
  };

  // F1a — declared-confidence capture: the caller's own confidence claim,
  // recorded verbatim (clamped to 0..1) for future calibration. This NEVER
  // feeds the gate: admission risk reads `confidence` (the policy/system
  // value) via admissionRiskFromConfidence() only. Keeping the two apart is
  // what lets a later calibration step distrust declarations based on track
  // record without changing what any gate decides today. A caller claim that
  // survives policy capping here would otherwise be indistinguishable from
  // the capped system value (e.g. 0.99 claimed on an invalid sourceType
  // reads as 0.2), destroying the (declaration, outcome) pairing.
  const declaredRaw = mergedInput.confidence;
  normalized.declaredConfidence =
    typeof declaredRaw === 'number' && !Number.isNaN(declaredRaw) ? clampConfidence(declaredRaw) : null;
  normalized.declaredConfidenceSource = normalized.declaredConfidence === null ? 'absent' : 'explicit';

  // The hash of what the source said at ingest, where the caller computed one.
  //
  // Set conditionally rather than in the literal above: an absent hash must stay
  // absent, because an empty string reads as "this was hashed, and the hash is
  // nothing" -- a claim, where no claim was made. sourceRef names a location and
  // keeps resolving after the content behind it changes; this is the field that
  // lets a reader tell the source that was read from the source they are looking
  // at now. See lib/content-hash.js for what that does and does not establish.
  const suppliedHash = sanitize(mergedInput.contentHash, '');
  if (suppliedHash) {
    normalized.contentHash = suppliedHash;
    normalized.contentHashAlgorithm = sanitize(mergedInput.contentHashAlgorithm, 'sha256') || 'sha256';
    // A caller-provided value is a declaration unless this boundary has
    // independently verified it against the ingested bytes. Keep the legacy
    // field for compatibility, but make its evidentiary status explicit.
    normalized.contentHashVerified = opts.contentHashVerified === true;
  }

  // The version identifier the source itself offered: a commit SHA, an ETag, a
  // Last-Modified. Distinct from contentHash, which we compute -- this is what
  // the source called the thing, and it is what makes `sourceRef` re-resolvable
  // to the same bytes rather than to whatever the location holds today.
  //
  // Conditional for the same reason as the hash: a source that offers no
  // validator must not produce a record that reads as pinned. The kind travels
  // with the value because an ETag and a Last-Modified are not equally strong,
  // and a reader who cannot tell them apart will treat the weak one as the
  // strong one.
  const suppliedVersion = sanitize(mergedInput.sourceVersion, '');
  if (suppliedVersion) {
    normalized.sourceVersion = suppliedVersion;
    normalized.sourceVersionKind = sanitize(mergedInput.sourceVersionKind, 'unspecified') || 'unspecified';
  }

  const sourceTypeInvalid = normalized.sourceType && !VALID_SOURCE_TYPES.has(normalized.sourceType);
  const confidenceInvalid = typeof normalized.confidence === 'number'
    && !Number.isNaN(normalized.confidence)
    && (normalized.confidence < 0 || normalized.confidence > 1);

  if (strictProvenance) {
    const requiredMissing = [];
    if (!normalized.provenanceId) requiredMissing.push('provenanceId');
    if (!normalized.sourceRef) requiredMissing.push('sourceRef');
    if (!normalized.sourceTitle) requiredMissing.push('sourceTitle');
    if (!normalized.sourceType) requiredMissing.push('sourceType');
    if (sourceTypeInvalid) requiredMissing.push('sourceType');
    if (!normalized.actor) requiredMissing.push('actor');
    if (!normalized.timestamp) requiredMissing.push('timestamp');
    if (typeof normalized.confidence !== 'number' || Number.isNaN(normalized.confidence)) requiredMissing.push('confidence');
    if (confidenceInvalid) requiredMissing.push('confidence');
    if (!normalized.workspaceId) requiredMissing.push('workspaceId');
    if (requiredMissing.length > 0) {
      const error = new ProvenanceError(`provenance is required when strictProvenance is true: missing ${requiredMissing.join(', ')}`);
      error.missing = requiredMissing;
      throw error;
    }
  }

  let rejectedSourceType = '';
  if (sourceTypeInvalid) {
    rejectedSourceType = normalized.sourceType;
    warnings.push(`invalid sourceType ${rejectedSourceType} rejected; recorded as ${INVALID_SOURCE_TYPE}`);
    normalized.sourceType = INVALID_SOURCE_TYPE;
  }

  if (confidenceInvalid) {
    warnings.push(`confidence clamped to 0..1 from ${normalized.confidence}`);
    normalized.confidence = clampConfidence(normalized.confidence);
  }

  if (!normalized.provenanceId) {
    normalized.provenanceId = makeProvenanceId(normalized);
  }

  if (!normalized.sourceTitle) normalized.sourceTitle = normalized.sourceRef || normalized.sourceType || 'unknown';
  if (!normalized.sourceRef && normalized.sourceTitle) normalized.sourceRef = normalized.sourceTitle;

  const policyApplied = applyTrustPolicyToProvenance(normalized, policy, {
    sourceType: normalized.sourceType,
    sourceSubType: normalized.sourceSubType,
  });

  const provenance = {
    ...policyApplied.provenance,
    trustPolicyVersion: getTrustPolicyVersion(policy),
  };

  if (sourceTypeInvalid) {
    // Applies to a caller-supplied confidence too: otherwise a request could
    // pair an unclassifiable type with a high confidence and keep it.
    const capped = Math.min(
      typeof provenance.confidence === 'number' && !Number.isNaN(provenance.confidence)
        ? provenance.confidence
        : INVALID_SOURCE_TYPE_MAX_CONFIDENCE,
      INVALID_SOURCE_TYPE_MAX_CONFIDENCE,
    );
    if (capped !== provenance.confidence) {
      warnings.push(`confidence capped to ${INVALID_SOURCE_TYPE_MAX_CONFIDENCE} for an invalid sourceType`);
    }
    provenance.confidence = capped;
    provenance.confidenceSource = 'invalid_source_type_floor';
    provenance.rejectedSourceType = rejectedSourceType;
  }

  warnings.push(...policyApplied.warnings);
  if (provenanceIdWasMissing) warnings.push('provenanceId auto-filled');
  if (sourceRefWasMissing) warnings.push('sourceRef auto-filled');
  if (sourceTitleWasMissing) warnings.push('sourceTitle auto-filled');
  if (sourceTypeWasMissing) warnings.push('sourceType auto-filled');
  if (actorWasMissing) warnings.push('actor auto-filled');
  if (timestampWasMissing) warnings.push('timestamp auto-filled');
  if (workspaceWasMissing) warnings.push('workspaceId auto-filled');

  return { provenance, warnings, policy };
}

module.exports = {
  INVALID_SOURCE_TYPE,
  INVALID_SOURCE_TYPE_MAX_CONFIDENCE,
  VALID_SOURCE_TYPES,
  buildProvenance,
  makeProvenanceId,
  legacyProvenanceId,
  isLegacyProvenanceId,
};

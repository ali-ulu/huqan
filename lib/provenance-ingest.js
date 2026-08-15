const crypto = require('crypto');
const { loadTrustPolicy, applyTrustPolicyToProvenance, getTrustPolicyVersion } = require('./trust-policy');
const { ProvenanceError } = require('./errors/provenance-error');

function nowIso() {
  return new Date().toISOString();
}

function sanitize(value, fallback = '') {
  const text = String(value == null ? '' : value).trim();
  return text || fallback;
}

const VALID_SOURCE_TYPES = new Set([
  'document',
  'api',
  'user',
  'agent',
  'system',
  'github',
  'import',
  'llm',
  // Written by paths inside this repository rather than by an external source.
  // They were emitted long before they were declared here, which meant every
  // one of them scored the unknown fallback; see
  // test/ingest-source-type-trust-weights.test.js.
  'manual', // a human typing a fact directly, with no external reference
  'decision', // a recorded decision, structured but internal
  'background_inference', // the kernel writing about its own bookkeeping
]);

/**
 * Identity and trust ceiling for a source type that failed classification
 * (#742).
 *
 * An unrecognized sourceType used to be rewritten to 'system', which the
 * default policy scores 0.5 — the same floor at which
 * admissionRiskFromConfidence() stops treating a write as review-worthy. So a
 * caller could take a low-trust known type such as 'llm' (0.4), misspell it as
 * 'llm-custom', and have it promoted past the source-based review gate. The
 * warning never affected the decision.
 *
 * An invalid type must never be more trusted than the type it failed to
 * classify as, so the ceiling sits strictly below every registered default
 * (the strictest is background_inference at 0.3). The ceiling is enforced in
 * code rather than by a policy entry, so a policy file that omits it cannot
 * reopen the gap.
 */
const INVALID_SOURCE_TYPE = 'invalid';
const INVALID_SOURCE_TYPE_MAX_CONFIDENCE = 0.2;

function clampConfidence(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return Math.max(0, Math.min(1, value));
}

function makeProvenanceId(input) {
  const sourceRef = sanitize(input.sourceRef);
  const subject = sanitize(input.subject);
  const object = sanitize(input.object);
  const base = input.provenanceId || input.id || `${sourceRef}|${subject}|${object}|${input.timestamp || ''}`;
  return `prov_${crypto.createHash('sha1').update(String(base), 'utf8').digest('hex').slice(0, 16)}`;
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

async function ingestWithProvenance(kernel, input = {}, opts = {}) {
  if (!kernel || typeof kernel.learn !== 'function') {
    throw new Error('kernel.learn gerekli');
  }

  const strictProvenance = Boolean(kernel.strictProvenance || opts.strictProvenance);
  const trustPolicyPath = opts.trustPolicyPath;
  const trustPolicy = opts.trustPolicy || loadTrustPolicy(trustPolicyPath);
  const text = sanitize(input.text || input.statement || opts.text || opts.statement, '');
  if (!text) {
    throw new Error('text veya statement gerekli');
  }

  const provenanceInput = input.provenance || opts.provenance || {
    provenanceId: input.provenanceId || opts.provenanceId || '',
    sourceRef: input.sourceRef || opts.sourceRef || '',
    sourceTitle: input.sourceTitle || opts.sourceTitle || '',
    sourceType: input.sourceType || opts.sourceType || '',
    sourceSubType: input.sourceSubType || opts.sourceSubType || '',
    actor: input.actor || opts.actor || '',
    timestamp: input.timestamp || opts.timestamp || '',
    confidence: input.confidence ?? opts.confidence,
    workspaceId: input.workspaceId || opts.workspaceId || '',
  };

  const built = buildProvenance(provenanceInput, {
    strictProvenance,
    trustPolicy,
    trustPolicyPath,
    sourceType: provenanceInput.sourceType,
    sourceSubType: provenanceInput.sourceSubType,
    sourceRef: provenanceInput.sourceRef,
    sourceTitle: provenanceInput.sourceTitle,
    actor: provenanceInput.actor,
    timestamp: provenanceInput.timestamp,
    workspaceId: provenanceInput.workspaceId,
  });

  const learnOpts = { ...opts };
  for (const key of [
    'provenance',
    'trustPolicy',
    'trustPolicyPath',
    'sourceRef',
    'sourceTitle',
    'actor',
    'timestamp',
    'confidence',
  ]) {
    delete learnOpts[key];
  }
  learnOpts.provenance = built.provenance;
  learnOpts.sourceType = built.provenance.sourceType;
  if (built.provenance.sourceSubType) learnOpts.sourceSubType = built.provenance.sourceSubType;
  learnOpts.workspaceId = built.provenance.workspaceId;

  const learnResult = kernel.learn(text, learnOpts);
  const learnedCount = Number(learnResult?.data?.learned || 0);
  const skippedCount = Number(learnResult?.data?.skipped || 0);
  const admissionOutcome = learnedCount > 0 ? 'admitted' : 'skipped';

  return {
    ...learnResult,
    provenance: built.provenance,
    provenanceWarnings: built.warnings,
    admission: {
      outcome: admissionOutcome,
      targetType: 'learn',
      targetId: text,
      workspaceId: built.provenance.workspaceId,
      provenanceId: built.provenance.provenanceId,
      sourceRef: built.provenance.sourceRef,
      graphWrite: learnedCount > 0,
      learned: learnedCount,
      skipped: skippedCount,
    },
  };
}

module.exports = {
  INVALID_SOURCE_TYPE,
  INVALID_SOURCE_TYPE_MAX_CONFIDENCE,
  VALID_SOURCE_TYPES,
  buildProvenance,
  ingestWithProvenance,
};

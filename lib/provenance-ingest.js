const crypto = require('crypto');
const { loadTrustPolicy, applyTrustPolicyToProvenance, getTrustPolicyVersion } = require('./trust-policy');

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
]);

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

function getProvenanceErrorClass() {
  try {
    const Kernel = require('../kernel');
    return Kernel.ProvenanceError || Error;
  } catch (_) {
    return Error;
  }
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
      const ProvenanceError = getProvenanceErrorClass();
      const error = new ProvenanceError(`provenance is required when strictProvenance is true: missing ${requiredMissing.join(', ')}`);
      error.missing = requiredMissing;
      throw error;
    }
  }

  if (sourceTypeInvalid) {
    warnings.push(`invalid sourceType ${normalized.sourceType} normalized to system`);
    normalized.sourceType = 'system';
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
  buildProvenance,
  ingestWithProvenance,
};

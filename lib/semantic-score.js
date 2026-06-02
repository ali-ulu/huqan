const { normalizeSignal } = require('./semantic-signals');

const DEFAULT_SEMANTIC_THRESHOLDS = Object.freeze({
  supportVerified: 0.75,
  contradictionConflict: 0.7,
  riskHigh: 0.4,
});

const CORE_STATUSES = Object.freeze(['dogrulandi', 'celiski', 'bilinmiyor']);

function clamp01(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeText(input) {
  return String(input ?? '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreFromSignals(signals = [], kind) {
  const list = asArray(signals)
    .map(normalizeSignal)
    .filter(signal => signal.kind === kind);

  if (list.length === 0) return 0;
  return list.reduce((max, signal) => Math.max(max, clamp01(signal.severity, 0), clamp01(signal.confidence, 0)), 0);
}

function buildSupportScore(input = {}, opts = {}) {
  const explicit = typeof input.supportScore === 'number' ? input.supportScore : typeof opts.supportScore === 'number' ? opts.supportScore : null;
  if (explicit !== null) return clamp01(explicit, 0);

  const evidence = asArray(input.evidence || opts.evidence);
  const directEvidence = evidence.some(item => {
    const text = normalizeText(item?.text || item?.description || item?.claim || item || '');
    return Boolean(text);
  });
  if (directEvidence) {
    return clamp01(0.8, 0.8);
  }

  const graphEvidence = asArray(input.graphEvidence || opts.graphEvidence);
  if (graphEvidence.length > 0) {
    return clamp01(Math.min(1, 0.55 + graphEvidence.length * 0.1), 0.55);
  }

  return 0;
}

function buildContradictionScore(signals = [], opts = {}) {
  const explicit = typeof opts.contradictionScore === 'number' ? opts.contradictionScore : null;
  const derived = scoreFromSignals(signals, 'contradiction');
  return clamp01(explicit !== null ? Math.max(explicit, derived) : derived, 0);
}

function buildRiskScore(signals = [], opts = {}) {
  const explicit = typeof opts.riskScore === 'number' ? opts.riskScore : null;
  const derived = scoreFromSignals(signals, 'risk');
  return clamp01(explicit !== null ? Math.max(explicit, derived) : derived, 0);
}

function determineClassification(status, supportScore, contradictionScore, riskScore, opts = {}) {
  if (status === 'celiski') return 'contradicted';
  if (status === 'dogrulandi') return 'verified';
  if (riskScore >= DEFAULT_SEMANTIC_THRESHOLDS.riskHigh && supportScore < DEFAULT_SEMANTIC_THRESHOLDS.supportVerified) {
    return 'needs_review';
  }
  if (supportScore > 0 && supportScore < DEFAULT_SEMANTIC_THRESHOLDS.supportVerified) {
    return 'weak_match';
  }
  if (supportScore === 0 && contradictionScore === 0) {
    return 'unsupported';
  }
  return 'needs_review';
}

function collectWarnings(signals = [], supportScore = 0, contradictionScore = 0, riskScore = 0) {
  const warnings = [];
  for (const signal of asArray(signals).map(normalizeSignal)) {
    warnings.push(...asArray(signal.flags));
  }
  if (supportScore > 0 && supportScore < DEFAULT_SEMANTIC_THRESHOLDS.supportVerified) warnings.push('WEAK_SUPPORT');
  if (contradictionScore > 0) warnings.push('CONTRADICTION_SIGNAL');
  if (riskScore >= DEFAULT_SEMANTIC_THRESHOLDS.riskHigh) warnings.push('HIGH_RISK');
  return [...new Set(warnings)].filter(Boolean);
}

function buildRiskObject(signals = [], riskScore = 0, opts = {}) {
  const normalizedSignals = asArray(signals).map(normalizeSignal);
  const flags = [...new Set([
    ...normalizedSignals.flatMap(signal => asArray(signal.flags)),
    ...(Array.isArray(opts.flags) ? opts.flags : []),
  ])].filter(Boolean);

  return {
    score: clamp01(riskScore, 0),
    flags,
    domain: typeof opts.domain === 'string' && opts.domain.trim() ? opts.domain.trim() : null,
    manipulation: Boolean(opts.manipulation),
    absoluteClaim: Boolean(opts.absoluteClaim),
    relationDrift: Boolean(opts.relationDrift),
    highRisk: riskScore >= DEFAULT_SEMANTIC_THRESHOLDS.riskHigh || Boolean(opts.highRisk),
  };
}

function normalizeSemanticClassification(result = {}) {
  const status = CORE_STATUSES.includes(result.status) ? result.status : 'bilinmiyor';
  const signals = asArray(result.signals).map(normalizeSignal);
  const supportScore = clamp01(result.supportScore, 0);
  const contradictionScore = clamp01(result.contradictionScore, 0);
  const riskScore = clamp01(result.riskScore, 0);
  const risk = buildRiskObject(signals, riskScore, result.risk);
  const warnings = Array.isArray(result.warnings) ? [...new Set(result.warnings.filter(Boolean))] : [];
  const meta = asObject(result.meta);

  return {
    status,
    classification: typeof result.classification === 'string' && result.classification.trim()
      ? result.classification.trim()
      : determineClassification(status, supportScore, contradictionScore, riskScore, result),
    supportScore,
    contradictionScore,
    riskScore,
    matchType: typeof result.matchType === 'string' && result.matchType.trim() ? result.matchType.trim() : 'unknown',
    warnings,
    risk,
    signals,
    meta,
  };
}

function classifySemanticTrust(input = {}, opts = {}) {
  const signals = asArray(input.signals || opts.signals).map(normalizeSignal);
  const supportScore = buildSupportScore(input, opts);
  const contradictionScore = buildContradictionScore(signals, {
    contradictionScore: input.contradictionScore ?? opts.contradictionScore,
  });
  const riskScore = buildRiskScore(signals, {
    riskScore: input.riskScore ?? opts.riskScore,
  });

  let status = 'bilinmiyor';
  if (contradictionScore >= DEFAULT_SEMANTIC_THRESHOLDS.contradictionConflict) {
    status = 'celiski';
  } else if (supportScore >= DEFAULT_SEMANTIC_THRESHOLDS.supportVerified && riskScore < DEFAULT_SEMANTIC_THRESHOLDS.riskHigh) {
    status = 'dogrulandi';
  }

  const classification = determineClassification(status, supportScore, contradictionScore, riskScore, input);
  const warnings = collectWarnings(signals, supportScore, contradictionScore, riskScore);
  const risk = buildRiskObject(signals, riskScore, {
    ...asObject(input.risk),
    ...asObject(opts.risk),
  });
  const matchType = typeof input.matchType === 'string' && input.matchType.trim()
    ? input.matchType.trim()
    : (supportScore >= DEFAULT_SEMANTIC_THRESHOLDS.supportVerified
      ? 'graph-backed'
      : supportScore > 0
        ? 'partial_match'
        : 'unknown');
  const meta = {
    ...asObject(input.meta),
    thresholds: { ...DEFAULT_SEMANTIC_THRESHOLDS },
  };

  return normalizeSemanticClassification({
    status,
    classification,
    supportScore,
    contradictionScore,
    riskScore,
    matchType,
    warnings,
    risk,
    signals,
    meta,
  });
}

function attachSemanticMeta(result = {}, semanticResult = {}) {
  const normalized = normalizeSemanticClassification(semanticResult);
  return {
    ...result,
    status: CORE_STATUSES.includes(result.status) ? result.status : normalized.status,
    classification: normalized.classification,
    supportScore: normalized.supportScore,
    contradictionScore: normalized.contradictionScore,
    riskScore: normalized.riskScore,
    matchType: normalized.matchType,
    warnings: normalized.warnings,
    risk: normalized.risk,
    signals: normalized.signals,
    meta: {
      ...asObject(result.meta),
      semantic: normalized,
    },
  };
}

module.exports = {
  DEFAULT_SEMANTIC_THRESHOLDS,
  attachSemanticMeta,
  buildContradictionScore,
  buildRiskScore,
  buildSupportScore,
  classifySemanticTrust,
  normalizeSemanticClassification,
};

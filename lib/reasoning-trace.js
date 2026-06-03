const crypto = require('node:crypto');
const { normalizeText } = require('./text-utils');

function clamp01(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

function stableHash(input) {
  return crypto.createHash('sha1').update(String(input ?? '')).digest('hex').slice(0, 16);
}

function normalizeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function normalizeTraceStep(step = {}) {
  return {
    type: String(step.type || 'unknown'),
    input: step.input,
    output: step.output,
    subclaimId: step.subclaimId || null,
    claim: typeof step.claim === 'string' ? step.claim : '',
    status: typeof step.status === 'string' ? step.status : 'bilinmiyor',
    confidence: clamp01(step.confidence, 0),
    rule: typeof step.rule === 'string' ? step.rule : '',
    reasons: normalizeArray(step.reasons),
    warnings: normalizeArray(step.warnings),
    evidence: normalizeArray(step.evidence),
    rejectedEvidence: normalizeArray(step.rejectedEvidence),
    downgradeReasons: normalizeArray(step.downgradeReasons),
    semanticTrust: step.semanticTrust && typeof step.semanticTrust === 'object' ? { ...step.semanticTrust } : {},
    risk: step.risk && typeof step.risk === 'object' ? { ...step.risk } : {},
  };
}

function summarizeOutcomes(subclaimOutcomes = []) {
  const list = normalizeArray(subclaimOutcomes);
  const supported = list.filter(item => item.status === 'dogrulandi').length;
  const contradicted = list.filter(item => item.status === 'celiski').length;
  const unknown = list.filter(item => item.status === 'bilinmiyor').length;
  const evidenceCount = list.reduce((sum, item) => sum + normalizeArray(item.evidence).length, 0);
  const contradictionCount = contradicted;
  const downgradeReasons = [...new Set(list.flatMap(item => normalizeArray(item.downgradeReasons)))];
  const semanticFlags = [...new Set(list.flatMap(item => normalizeArray(item.semanticTrust?.warnings)))]
    .filter(Boolean);

  return {
    supported,
    contradicted,
    unknown,
    total: list.length,
    evidenceCount,
    contradictionCount,
    downgradeReasons,
    semanticFlags,
  };
}

function aggregateSubclaimVerdicts(subclaims = [], opts = {}) {
  const list = normalizeArray(subclaims).map(item => ({
    id: String(item.id || item.subclaimId || 'claim_1'),
    claim: String(item.claim || ''),
    required: item.required !== false,
    status: ['dogrulandi', 'celiski', 'bilinmiyor'].includes(item.status) ? item.status : 'bilinmiyor',
    confidence: clamp01(item.confidence, 0),
    evidence: normalizeArray(item.evidence),
    rejectedEvidence: normalizeArray(item.rejectedEvidence),
    downgradeReasons: normalizeArray(item.downgradeReasons),
    semanticTrust: item.semanticTrust && typeof item.semanticTrust === 'object' ? { ...item.semanticTrust } : {},
    risk: item.risk && typeof item.risk === 'object' ? { ...item.risk } : {},
  }));

  const required = list.filter(item => item.required);
  const requiredList = required.length > 0 ? required : list;
  const floor = Number.isFinite(Number(opts.confidenceFloor)) ? Number(opts.confidenceFloor) : 0.65;

  const contradicted = requiredList.filter(item => item.status === 'celiski');
  const supported = requiredList.filter(item => item.status === 'dogrulandi');
  const unknown = requiredList.filter(item => item.status === 'bilinmiyor');

  let status = 'bilinmiyor';
  let finalRule = 'PARTIAL_OR_UNKNOWN';
  let confidence = 0;

  if (contradicted.length > 0) {
    status = 'celiski';
    confidence = contradicted.reduce((max, item) => Math.max(max, item.confidence), 0);
    finalRule = 'ANY_REQUIRED_CONTRADICTED';
  } else if (requiredList.length > 0 && supported.length === requiredList.length) {
    const minConfidence = supported.reduce((min, item) => Math.min(min, item.confidence), 1);
    if (minConfidence >= floor) {
      status = 'dogrulandi';
      confidence = minConfidence;
      finalRule = 'ALL_REQUIRED_SUPPORTED';
    } else {
      confidence = minConfidence;
      finalRule = 'CONFIDENCE_FLOOR';
    }
  } else {
    confidence = list.reduce((max, item) => Math.max(max, item.confidence), 0);
  }

  const summary = summarizeOutcomes(list);
  const reasons = [...summary.downgradeReasons];
  if (unknown.length > 0) reasons.push('UNKNOWN_SUBCLAIM');
  if (status !== 'dogrulandi' && supported.length > 0 && supported.length === requiredList.length && confidence < floor) {
    reasons.push('CONFIDENCE_FLOOR');
  }
  if (contradicted.length > 0) reasons.push('CONTRADICTION_SUBCLAIM');

  return {
    status,
    confidence: clamp01(confidence, 0),
    finalRule,
    summary: {
      supported: summary.supported,
      contradicted: summary.contradicted,
      unknown: summary.unknown,
      total: summary.total,
      finalRule,
    },
    reasons: [...new Set(reasons.filter(Boolean))],
  };
}

function buildReasoningTrace(input = {}, opts = {}) {
  const claim = String(input.claim || input.originalClaim || '').trim();
  const decomposition = input.decomposition || {};
  const subclaimOutcomes = normalizeArray(input.subclaimOutcomes);
  const aggregate = input.aggregate || aggregateSubclaimVerdicts(subclaimOutcomes, opts);
  const steps = [];

  steps.push(normalizeTraceStep({
    type: 'decomposition',
    input: claim,
    output: {
      originalClaim: decomposition.originalClaim || claim,
      compound: Boolean(decomposition.compound),
      subclaims: normalizeArray(decomposition.subclaims).map(subclaim => ({
        id: subclaim.id,
        claim: subclaim.claim,
        subject: subclaim.subject || '',
        predicate: subclaim.predicate || '',
        object: subclaim.object || '',
        required: subclaim.required !== false,
        source: subclaim.source || 'deterministic',
      })),
    },
    warnings: normalizeArray(decomposition.warnings),
  }));

  for (const outcome of subclaimOutcomes) {
    steps.push(normalizeTraceStep({
      type: 'subclaim_verification',
      subclaimId: outcome.id,
      claim: outcome.claim,
      status: outcome.status,
      confidence: outcome.confidence,
      evidence: outcome.evidence,
      rejectedEvidence: outcome.rejectedEvidence,
      downgradeReasons: outcome.downgradeReasons,
      semanticTrust: outcome.semanticTrust,
      risk: outcome.risk,
    }));
  }

  steps.push(normalizeTraceStep({
    type: 'aggregation',
    rule: aggregate.finalRule,
    status: aggregate.status,
    confidence: aggregate.confidence,
    reasons: aggregate.reasons,
  }));

  const traceId = stableHash([
    normalizeText(claim),
    aggregate.status,
    aggregate.confidence.toFixed(4),
    aggregate.finalRule,
    subclaimOutcomes.map(item => `${item.id}:${item.status}:${Number(item.confidence || 0).toFixed(4)}`).join('|'),
  ].join('::'));

  const semanticFlags = [...new Set([
    ...normalizeArray(input.semanticFlags),
    ...normalizeArray(input.warnings),
    ...aggregate.reasons,
    ...steps.flatMap(step => normalizeArray(step.warnings)),
  ])].filter(Boolean);

  const evidenceCount = subclaimOutcomes.reduce((sum, item) => sum + normalizeArray(item.evidence).length, 0);
  const contradictionCount = subclaimOutcomes.filter(item => item.status === 'celiski').length;
  const downgradeReasons = [...new Set([
    ...aggregate.reasons,
    ...subclaimOutcomes.flatMap(item => normalizeArray(item.downgradeReasons)),
  ])].filter(Boolean);

  return {
    traceId,
    claim,
    status: aggregate.status,
    confidence: aggregate.confidence,
    mode: 'semantic-trace',
    steps,
    summary: aggregate.summary,
    trustReceiptPreview: {
      originalClaim: claim,
      finalStatus: aggregate.status,
      confidence: aggregate.confidence,
      subclaimCount: subclaimOutcomes.length,
      evidenceCount,
      contradictionCount,
      downgradeReasons,
      semanticFlags,
      canonical: aggregate.status === 'dogrulandi',
    },
  };
}

function attachReasoningTrace(verifyResult = {}, trace = {}, opts = {}) {
  const meta = verifyResult.meta && typeof verifyResult.meta === 'object' ? { ...verifyResult.meta } : {};
  const nextTrace = trace && typeof trace === 'object' ? trace : buildReasoningTrace({ claim: verifyResult?.data?.claim || '' }, opts);
  return {
    ...verifyResult,
    meta: {
      ...meta,
      reasoningTrace: nextTrace,
      trustReceiptPreview: nextTrace.trustReceiptPreview,
    },
  };
}

module.exports = {
  aggregateSubclaimVerdicts,
  attachReasoningTrace,
  buildReasoningTrace,
  normalizeTraceStep,
};

// The causal summary: risk level, conclusion, next questions and
// recommendation over a normalised simulation result. Moved out of
// finalizer.js (#2170).

const { cloneValue, dedupeStable, extractText, normalizeText, safeStringify } = require('./finalizer-text');
const { normalizeAffectedNode, normalizeCausalEvidence, normalizeCausalOutcome, normalizeCausalRisk, normalizeCausalTraversal } = require('./finalizer-causal-normalize');

function deriveCausalRiskLevel(risks, confidence = 0, causalChains = 0, evidence = []) {
  if (!Array.isArray(risks) || risks.length === 0) {
    if (causalChains === 0 || !Array.isArray(evidence) || evidence.length === 0) {
      return 'unknown';
    }
    return confidence >= 0.75 ? 'low' : 'unknown';
  }

  if (risks.some(r => r.severity === 'critical')) return 'critical';
  if (risks.some(r => r.severity === 'high')) return 'high';
  if (risks.some(r => r.severity === 'medium')) return 'medium';
  if (risks.some(r => r.severity === 'low')) return 'low';
  return 'unknown';
}

function causalRiskMessage(riskLevel) {
  switch (riskLevel) {
    case 'critical':
      return 'The change is not recommended.';
    case 'high':
      return 'High risk; human approval is required.';
    case 'medium':
      return 'Apply with care.';
    case 'low':
      return 'Low risk.';
    default:
      return 'Yetersiz causal veri.';
  }
}

function deriveCausalConclusion({ riskLevel, recommendation, confidence, causalChains }) {
  const head = `Karar: ${causalRiskMessage(riskLevel)}`;
  const recommendationText = recommendation ? ` Recommendation: ${normalizeText(recommendation)}` : '';
  const confidenceText = ` Confidence: ${(Math.max(0, Math.min(1, confidence || 0)) * 100).toFixed(1)}%.`;
  const chainText = causalChains > 0 ? ` Causal chain count: ${causalChains}.` : ' Causal chain yok.';
  return `${head}${recommendationText}${confidenceText}${chainText}`.trim();
}

function deriveCausalNextQuestions({ unknowns, riskLevel }) {
  const questionSet = [];
  for (const unknown of unknowns) {
    const text = normalizeText(unknown);
    if (!text) continue;
    questionSet.push(/\?$/.test(text) ? text : `${text}?`);
  }

  if (riskLevel === 'critical' || riskLevel === 'high') {
    questionSet.push('What alternatives are there for reducing this risk?');
    questionSet.push('Is human approval or additional evidence required?');
  } else if (riskLevel === 'medium') {
    questionSet.push('What additional data would make this decision safe?');
  } else if (riskLevel === 'unknown' && questionSet.length === 0) {
    questionSet.push('What evidence is missing for this causal chain?');
  }

  if (questionSet.length === 0) {
    questionSet.push('Which further observations would confirm this result?');
  }

  return dedupeStable(questionSet);
}

function buildCausalSummary(simulationResult = {}) {
  if (!simulationResult.ok) {
    return {
      ok: false,
      error: simulationResult.error || 'Simulation failed',
      outcomes: [],
      risks: [],
      summary: '',
    };
  }

  const outcomes = Array.isArray(simulationResult.outcomes)
    ? simulationResult.outcomes.map(normalizeCausalOutcome).filter(Boolean)
    : [];

  const risks = Array.isArray(simulationResult.risks)
    ? simulationResult.risks.map(normalizeCausalRisk).filter(Boolean)
    : [];

  const confidence = typeof simulationResult.confidence === 'number' ? simulationResult.confidence : 0;
  const causalChains = typeof simulationResult.causalChains === 'number' ? simulationResult.causalChains : 0;
  const isCausalMode =
    simulationResult.mode === 'causal' ||
    Array.isArray(simulationResult.affectedNodes) ||
    Array.isArray(simulationResult.unknowns) ||
    Array.isArray(simulationResult.traversal?.loops) ||
    Object.prototype.hasOwnProperty.call(simulationResult, 'riskLevel');

  const summary = simulationResult.summary || 
    `Simulation found ${outcomes.length} outcome(s) with ${risks.length} risk(s). Confidence: ${(confidence * 100).toFixed(1)}%`;

  if (!isCausalMode) {
    return {
      ok: true,
      action: normalizeText(simulationResult.action || ''),
      nodeId: simulationResult.nodeId || '',
      changeType: simulationResult.changeType || 'unknown',
      outcomes,
      risks,
      confidence,
      causalChains,
      summary,
      recommendation: deriveCausalRecommendation(risks, confidence),
    };
  }

  const affectedNodes = Array.isArray(simulationResult.affectedNodes)
    ? simulationResult.affectedNodes.map(normalizeAffectedNode).filter(Boolean)
    : [];
  const evidence = normalizeCausalEvidence(simulationResult.evidence);
  const unknowns = dedupeStable(
    (Array.isArray(simulationResult.unknowns) ? simulationResult.unknowns : simulationResult.unknowns ? [simulationResult.unknowns] : [])
      .map(item => extractText(item) || normalizeText(typeof item === 'string' ? item : safeStringify(item)))
      .filter(Boolean)
  );
  const recommendation = normalizeText(
    simulationResult.recommendation || deriveCausalRecommendation(risks, confidence)
  );
  const input = simulationResult.input && typeof simulationResult.input === 'object'
    ? cloneValue(simulationResult.input)
    : {
        action: normalizeText(simulationResult.action || ''),
        nodeId: simulationResult.nodeId || '',
        changeType: simulationResult.changeType || 'unknown',
        newState: typeof simulationResult.newState === 'undefined' ? null : cloneValue(simulationResult.newState),
      };
  const riskLevel = deriveCausalRiskLevel(risks, confidence, causalChains, evidence);
  const traversal = normalizeCausalTraversal(simulationResult.traversal, {
    start: simulationResult.nodeId || '',
    nodeId: simulationResult.nodeId || '',
    maxDepth: input.maxDepth,
    confidence,
    stoppedReason: simulationResult.traversal?.stoppedReason || (causalChains > 0 ? 'exhausted' : 'insufficient-data'),
  });
  const conclusion = deriveCausalConclusion({
    riskLevel,
    recommendation,
    confidence,
    causalChains,
  });
  const nextQuestions = deriveCausalNextQuestions({
    unknowns,
    riskLevel,
  });

  return {
    ok: true,
    mode: 'causal',
    input,
    action: normalizeText(simulationResult.action || ''),
    nodeId: simulationResult.nodeId || '',
    changeType: simulationResult.changeType || 'unknown',
    conclusion,
    riskLevel,
    outcomes,
    risks,
    confidence,
    causalChains,
    affectedNodes,
    evidence,
    unknowns,
    recommendation,
    nextQuestions,
    summary,
    sourceMode: normalizeText(simulationResult.mode || 'causal') || 'causal',
    traversal,
  };
}

function deriveCausalRecommendation(risks, confidence) {
  if (risks.length === 0) {
    if (confidence > 0.7) {
      return 'The change looks safe; you can proceed with high confidence.';
    }
    return 'No risk found, but confidence is low; more evidence is needed.';
  }

  const criticalRisks = risks.filter(r => r.severity === 'critical');
  if (criticalRisks.length > 0) {
    return `CRITICAL: ${criticalRisks.length} critical risk(s) detected. The change is not recommended.`;
  }

  const highRisks = risks.filter(r => r.severity === 'high');
  if (highRisks.length > 0) {
    return `HIGH RISK: ${highRisks.length} high risk(s) detected. Proceed carefully or consider an alternative.`;
  }

  return `${risks.length} risk(s) detected. Assess them before proceeding.`;
}

module.exports = { buildCausalSummary, deriveCausalRecommendation };

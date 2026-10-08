const { DEFAULT_SEMANTIC_THRESHOLDS, normalizeSemanticClassification } = require('./semantic-score');
const { decomposeClaim } = require('./claim-decomposition');
const { aggregateSubclaimVerdicts, buildReasoningTrace } = require('./reasoning-trace');
const {
  detectAbsoluteClaim,
  detectAliasNormalization,
  detectDoubleNegation,
  detectHighRiskDomain,
  detectMultilingualAmbiguity,
  detectStrawmanAttribution,
  detectWeakPartialMatch,
  detectWeaselWords,
} = require('./risk-rules');
const { runContradictionRules } = require('./contradiction-rules');
const { partitionSignalsByKind } = require('./verify-contradiction-evidence');
const { analyzeFuzzyOverlap } = require('./fuzzy-normalization');
const { runSemanticSignals } = require('./semantic-signals');
const { detectTypeLatticeConflict } = require('./type-lattice');
const { resolveEntity } = require('./entity-resolution');
const { evaluateSemanticModel, strongestSemanticModel, resolveSemanticModelMode } = require('./semantic-model-port');

// Bounds model work per verify; each pair is sub-millisecond, the graph fan-out is not.
const MAX_SEMANTIC_MODEL_PAIRS = 16;

function edgeClaim(edge = {}) {
  return {
    text: `${edge.from || ''} ${edge.relation || ''} ${edge.to || ''}`.trim(),
    subject: edge.from || '',
    relation: edge.relation || '',
    object: edge.to || '',
    to: edge.to || '',
  };
}

function buildCausalPreventionConflict(subject, directEdge, statement, incomingPrevents) {
  if (directEdge?.relation !== 'CAUSES' || !incomingPrevents) return null;
  const confidence = Math.min(0.95, (directEdge.strength ?? directEdge.confidence ?? directEdge.weight ?? 0.5) + 0.3);
  return {
    data: { status: 'contradicted', confidence },
    evidence: [{
      kind: 'contradiction',
      text: `${subject} --[CAUSES]--> ${directEdge.to} conflicts with prevention claim: "${statement}"`,
      confidence,
      nodes: [subject, directEdge.to],
      edges: [{ from: subject, to: directEdge.to, relation: 'CAUSES' }],
    }],
  };
}

function uniqueFlags(signals = []) {
  return [...new Set([].concat(...signals.map(signal => Array.isArray(signal?.flags) ? signal.flags : [])))].filter(Boolean);
}

function maxSignalScore(signals = []) {
  return signals.reduce((max, signal) => Math.max(
    max,
    Number(signal?.severity) || 0,
    Number(signal?.confidence) || 0,
  ), 0);
}

/**
 * Statement-level risk detectors, in the order their signals are emitted
 * (#2401). A new detector is a new entry here, not another call-and-push.
 */
const STATEMENT_RISK_DETECTORS = Object.freeze([
  detectHighRiskDomain,
  detectAbsoluteClaim,
  detectDoubleNegation,
  detectWeaselWords,
  detectStrawmanAttribution,
  detectAliasNormalization,
  detectMultilingualAmbiguity,
]);

const PARTIAL_SUPPORT_CEILING = 0.49;
const PARTIAL_SUPPORT_FALLBACK = 0.35;

/** Support from the verify result: none for a contradiction, capped for a partial match. */
function supportScoreFor(result, rawConfidence, hasPartialEvidence) {
  if (result?.status === 'contradicted') return 0;
  return hasPartialEvidence ? Math.min(rawConfidence || PARTIAL_SUPPORT_FALLBACK, PARTIAL_SUPPORT_CEILING) : rawConfidence;
}

/**
 * Runs the contradiction rules of every known edge against the incoming
 * claim. #1619: signals are routed by their own `kind`. PREDICATE_DRIFT
 * declares itself `risk` -- "not a refutation" -- yet was once scored as one,
 * which turned every differently-worded fact about a known subject into an
 * evidence-free `contradicted` at 0.6.
 */
function incomingClaim({ statement, subject, predicate }) {
  return { text: statement, subject, relation: predicate, object: predicate, to: predicate };
}

/**
 * R51 (#3583): the own-weight model reads the same stored-edge / statement
 * pairs the rules read, regardless of the verdict, so shadow mode observes
 * live traffic. Null in mode `off` or when there is no edge to compare.
 */
function edgeSemanticModel({ statement, subject, predicate, edges }) {
  if (!Array.isArray(edges) || edges.length === 0) return null;
  const mode = resolveSemanticModelMode();
  if (mode === 'off') return null;
  const incoming = incomingClaim({ statement, subject, predicate });
  return strongestSemanticModel(edges.slice(0, MAX_SEMANTIC_MODEL_PAIRS)
    .map(edge => evaluateSemanticModel(edgeClaim(edge), incoming, { mode })));
}

function edgeRuleSignals({ statement, subject, predicate, edges }) {
  const contradictions = [];
  const risks = [];
  const incoming = incomingClaim({ statement, subject, predicate });
  for (const edge of edges) {
    const partitioned = partitionSignalsByKind(runContradictionRules(edgeClaim(edge), incoming, {}));
    contradictions.push(...partitioned.contradictions);
    risks.push(...partitioned.risks);
  }
  return { contradictions, risks };
}

function verifyContradictionSignal({ statement, subject, predicate, rawConfidence, evidenceList }) {
  return {
    rule: 'VERIFY_CONTRADICTION',
    kind: 'contradiction',
    severity: 0.9,
    confidence: Math.max(0.7, rawConfidence),
    flags: ['VERIFY_CONTRADICTION'],
    detail: 'Verify returned contradiction.',
    evidence: evidenceList,
    meta: { statement, subject, predicate },
  };
}

/**
 * A verified result backed only by weak evidence falls back to unknown; an
 * unverified one with a strong enough contradiction becomes contradicted.
 */
function resolveStatus(result, { hasAnyEvidenceKind, supportScore, contradictionScore }) {
  const status = ['verified', 'contradicted', 'unknown'].includes(result?.status) ? result.status : 'unknown';
  if (hasAnyEvidenceKind && status === 'verified' && supportScore < DEFAULT_SEMANTIC_THRESHOLDS.supportVerified) {
    return 'unknown';
  }
  if (status !== 'verified' && contradictionScore >= DEFAULT_SEMANTIC_THRESHOLDS.contradictionConflict) {
    return 'contradicted';
  }
  return status;
}

function matchTypeFor(evidenceKinds, hasContradiction) {
  for (const kind of ['partial_match', 'path', 'direct_edge']) {
    if (evidenceKinds.includes(kind)) return kind;
  }
  return hasContradiction ? 'contradiction' : 'unknown';
}

function buildVerifySemanticTrust({
  statement = '',
  result = {},
  evidence = [],
  subject = '',
  predicate = '',
  edges = [],
  workspaceId = 'default',
  pathSearch = null,
  fuzzy = null,
  typeConflict = null,
  contradictionSignals: seedContradictionSignals = [],
}) {
  const evidenceList = Array.isArray(evidence) ? evidence : [];
  const evidenceKinds = [...new Set(evidenceList.map(item => String(item?.kind || '').trim()).filter(Boolean))];
  const rawConfidence = Number(result?.confidence) || 0;
  const hasPartialEvidence = evidenceKinds.includes('partial_match');
  const hasAnyEvidenceKind = hasPartialEvidence || evidenceKinds.includes('path') || evidenceKinds.includes('direct_edge');
  const supportScore = supportScoreFor(result, rawConfidence, hasPartialEvidence);

  const riskSignals = [];
  const contradictionSignals = Array.isArray(seedContradictionSignals) ? [...seedContradictionSignals] : [];
  if (typeConflict) contradictionSignals.push(typeConflict);

  const weakPartial = result?.status !== 'contradicted' && (evidenceList.length > 0 || result?.status === 'verified')
    ? detectWeakPartialMatch({ confidence: supportScore, evidence: evidenceList }, {})
    : null;
  if (weakPartial) riskSignals.push(weakPartial);

  const statementRisks = STATEMENT_RISK_DETECTORS.map(detect => detect(statement, {}));
  const [highRisk, absolute] = statementRisks;
  riskSignals.push(...statementRisks.filter(Boolean));

  if (result?.status !== 'verified' && Array.isArray(edges) && edges.length > 0) {
    const fromEdges = edgeRuleSignals({ statement, subject, predicate, edges });
    contradictionSignals.push(...fromEdges.contradictions);
    riskSignals.push(...fromEdges.risks);
  }

  if (result?.status === 'contradicted' && contradictionSignals.length === 0) {
    contradictionSignals.push(verifyContradictionSignal({ statement, subject, predicate, rawConfidence, evidenceList }));
  }

  const contradictionScore = maxSignalScore(contradictionSignals);
  const riskScore = maxSignalScore(riskSignals);
  const status = resolveStatus(result, { hasAnyEvidenceKind, supportScore, contradictionScore });
  const matchType = matchTypeFor(evidenceKinds, contradictionSignals.length > 0);

  const signals = [...contradictionSignals, ...riskSignals];
  const warnings = uniqueFlags(signals);
  const semanticTrust = normalizeSemanticClassification({
    status,
    supportScore,
    contradictionScore,
    riskScore,
    matchType,
    warnings,
    risk: {
      flags: warnings,
      domain: highRisk?.meta?.domain || null,
      manipulation: false,
      absoluteClaim: Boolean(absolute),
      relationDrift: warnings.includes('RELATION_DRIFT'),
      highRisk: Boolean(highRisk),
    },
    signals,
    meta: {
      statement,
      subject,
      predicate,
      workspaceId,
      evidenceKinds,
      pathSearch,
      fuzzy,
      thresholds: { ...DEFAULT_SEMANTIC_THRESHOLDS },
    },
  });

  const trust = {
    ...semanticTrust,
    confidence: Math.max(rawConfidence, semanticTrust.supportScore || 0, semanticTrust.contradictionScore || 0),
    thresholds: { ...DEFAULT_SEMANTIC_THRESHOLDS },
  };
  // A separate typed field: status, confidence and signals above never read it.
  const semanticModel = edgeSemanticModel({ statement, subject, predicate, edges });
  return semanticModel ? { ...trust, semanticModel } : trust;
}

function pathSupportConfidence(graph, path, workspaceId) {
  const weights = [];
  for (let index = 0; index < path.length - 1; index += 1) {
    const from = path[index];
    const to = path[index + 1];
    const edge = graph.getEdges(from, workspaceId).find(candidate => candidate.to === to)
      || graph.getEdges(to, workspaceId).find(candidate => candidate.to === from);
    const weight = edge?.confidence ?? edge?.weight;
    if (typeof weight === 'number' && Number.isFinite(weight)) weights.push(weight);
  }
  const weakestWeight = weights.length > 0 ? Math.min(...weights) : 0.5;
  return Number(Math.min(0.95, weakestWeight + 0.3).toFixed(6));
}

module.exports = {
  edgeClaim,
  buildCausalPreventionConflict,
  uniqueFlags,
  maxSignalScore,
  pathSupportConfidence,
  buildVerifySemanticTrust,
};


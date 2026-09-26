const { normalizeWorkspaceId } = require("./workspace-id");
const { buildVerifySemanticTrust } = require("./verify-native");
const { decomposeClaim } = require("./claim-decomposition");
const { aggregateSubclaimVerdicts, buildReasoningTrace } = require("./reasoning-trace");
const { enforceEvidencedContradiction } = require("./verify-contradiction-evidence");
const { attachRobustnessMeta } = require("./trust-signals/verify-wiring");
const { resolveEntity } = require("./entity-resolution");

// VerifyService's verdict assembly and canonical-subject lookup (lib/verify.js),
// installed as non-enumerable prototype methods, as class methods are.
/** Public verdict assembly (#2344): `verify()` routes every outcome through this; it is the seam a caller outside this module may use. */
function verifyResult(statement, opts, data, evidence, context = {}) {
  const workspaceId = normalizeWorkspaceId(opts.workspaceId || context.workspaceId);
  const semanticTrust = buildVerifySemanticTrust({
    statement,
    result: data,
    evidence,
    subject: context.subject || '',
    predicate: context.predicate || '',
    edges: Array.isArray(context.edges) ? context.edges : [],
    workspaceId,
    pathSearch: context.pathSearch || null,
    fuzzy: context.fuzzy || null,
    typeConflict: context.typeConflict || null,
    contradictionSignals: Array.isArray(context.contradictionSignals) ? context.contradictionSignals : [],
  });
  // #1619: a refutation must name what refutes it. The semantic pass can
  // escalate to `contradicted` after verify has already fixed its evidence
  // list, which shipped `contradicted` with `evidence: []`.
  const guarded = enforceEvidencedContradiction({
    ...data,
    status: semanticTrust.status,
    confidence: semanticTrust.confidence,
  }, evidence, semanticTrust);
  const nextData = guarded.data;
  const resolvedEvidence = guarded.evidence;
  const decomposition = context.decomposition || (opts.skipDecomposition
    ? {
        originalClaim: statement,
        compound: false,
        subclaims: [{ id: 'claim_1', claim: statement, required: true, source: 'deterministic' }],
        warnings: [],
      }
    : decomposeClaim(statement));
  const subclaimOutcomes = Array.isArray(context.subclaimOutcomes) && context.subclaimOutcomes.length > 0
    ? context.subclaimOutcomes
    : [{
      id: 'claim_1',
      claim: statement,
      required: true,
      status: nextData.status,
      confidence: nextData.confidence,
      evidence: resolvedEvidence,
      rejectedEvidence: Array.isArray(context.rejectedEvidence) ? context.rejectedEvidence : [],
      downgradeReasons: Array.isArray(context.downgradeReasons) ? context.downgradeReasons : [],
      semanticTrust,
      risk: semanticTrust.risk || {},
    }];
  const aggregate = context.aggregate || aggregateSubclaimVerdicts(subclaimOutcomes, {
    confidenceFloor: opts.confidenceFloor,
  });
  const reasoningTrace = context.reasoningTrace || buildReasoningTrace({
    claim: statement,
    decomposition,
    subclaimOutcomes,
    aggregate,
    semanticFlags: semanticTrust.warnings,
  }, {
    confidenceFloor: opts.confidenceFloor,
  });
  const trustReceiptPreview = context.trustReceiptPreview || reasoningTrace.trustReceiptPreview;
  const subjectLiteral = typeof context.subjectLiteral === 'string' && context.subjectLiteral.trim()
    ? context.subjectLiteral.trim()
    : (typeof context.subject === 'string' ? context.subject.trim() : '');
  const lookupSubject = typeof context.lookupSubject === 'string' && context.lookupSubject.trim()
    ? context.lookupSubject.trim()
    : (typeof context.subject === 'string' ? context.subject.trim() : '');
  const resolvedSubject = subjectLiteral
    ? resolveEntity(subjectLiteral, { domain: opts.domain })
    : { matched: false, reason: 'empty_subject' };
  const entityResolution = {
    subject: subjectLiteral
      ? {
          original: subjectLiteral,
          ...resolvedSubject,
          usedForLookup: Boolean(
            lookupSubject &&
            lookupSubject !== subjectLiteral &&
            resolvedSubject.matched &&
            !resolvedSubject.ambiguous &&
            resolvedSubject.canonical === lookupSubject
          ),
        }
      : { original: '', matched: false, reason: 'empty_subject', usedForLookup: false },
  };
  return this.kernel.ok('verify', nextData, resolvedEvidence, attachRobustnessMeta(this, {
    semanticTrust, reasoningTrace, trustReceiptPreview, entityResolution,
  }, statement, opts));
}

function _resolveCanonicalSubjectLookup(statement, subjectMatch, parts, workspaceId, domain) {
  const rawTokens = String(statement || '').trim().match(/\S+/g) || [];
  const domainValue = typeof domain === 'string' && domain.trim() ? domain.trim() : undefined;
  const candidateLimit = Math.max(1, Math.min(4, rawTokens.length - 1));
  const seen = new Set();

  let fallbackLiteral = subjectMatch?.subject || rawTokens[0] || '';
  let lookupSubject = subjectMatch?.subject || fallbackLiteral;

  for (let len = candidateLimit; len >= 1; len--) {
    const candidate = rawTokens.slice(0, len).join(' ').trim();
    if (!candidate) continue;

    const normalizedCandidate = this.kernel.normalizeWord(candidate);
    if (!normalizedCandidate || seen.has(normalizedCandidate)) continue;
    seen.add(normalizedCandidate);

    const resolution = resolveEntity(candidate, { domain: domainValue });
    fallbackLiteral = candidate;

    if (resolution.ambiguous) {
      return {
        subjectLiteral: candidate,
        lookupSubject,
      };
    }

    if (resolution.matched && resolution.canonical) {
      const canonicalNode = this.kernel.graph.getNode(resolution.canonical, workspaceId);
      if (canonicalNode) {
        return {
          subjectLiteral: candidate,
          lookupSubject: resolution.canonical,
        };
      }
      return {
        subjectLiteral: candidate,
        lookupSubject: candidate,
      };
    }
  }

  return {
    subjectLiteral: fallbackLiteral,
    lookupSubject,
  };
}

function installVerifyResultMethods(proto) {
  for (const method of [verifyResult, _resolveCanonicalSubjectLookup]) {
    Object.defineProperty(proto, method.name, {
      value: method, writable: true, configurable: true, enumerable: false,
    });
  }
}

module.exports = { installVerifyResultMethods };

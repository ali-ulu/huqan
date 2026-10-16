const { aggregateSubclaimVerdicts, buildReasoningTrace } = require("./reasoning-trace");

// The compound-claim branch of VerifyService#verify (lib/verify.js): each
// subclaim is verified on its own and the verdicts aggregated.
function verifyCompound(service, statement, opts, workspaceId, decomposition) {
  const verdict = (...args) => service.verifyResult(...args);
  const traceDepth = Number(opts.reasoningTraceDepth) || 0;
  const maxDepth = Number.isFinite(Number(opts.maxDecompositionDepth)) ? Number(opts.maxDecompositionDepth) : 2;
  if (traceDepth >= maxDepth) {
    return verdict(statement, opts, { status: 'unknown', confidence: 0 }, [], {
      workspaceId,
      decomposition,
      reasoningTrace: buildReasoningTrace({
        claim: statement,
        decomposition,
        subclaimOutcomes: [],
        aggregate: aggregateSubclaimVerdicts([], { confidenceFloor: opts.confidenceFloor }),
      }),
    });
  }

  const subclaimResults = decomposition.subclaims.map((subclaim) => service.host.verifyInternal(subclaim.claim, {
    ...opts,
    workspaceId,
    skipDecomposition: true,
    reasoningTraceDepth: traceDepth + 1,
    parentClaim: statement,
    subclaimId: subclaim.id,
  }));

  const subclaimOutcomes = decomposition.subclaims.map((subclaim, index) => {
    const result = subclaimResults[index] || {};
    const data = result.data && typeof result.data === 'object' ? result.data : {};
    const semanticTrust = result.meta && typeof result.meta === 'object' ? result.meta.semanticTrust : null;
    const evidence = Array.isArray(result.evidence) ? result.evidence : [];
    const warnings = Array.isArray(semanticTrust?.warnings) ? semanticTrust.warnings : [];
    return {
      id: subclaim.id,
      claim: subclaim.claim,
      required: subclaim.required !== false,
      status: ['verified', 'contradicted', 'unknown'].includes(data.status) ? data.status : 'unknown',
      confidence: typeof data.confidence === 'number' ? data.confidence : 0,
      evidence,
      rejectedEvidence: Array.isArray(data?.meta?.rejectedEvidence) ? data.meta.rejectedEvidence : [],
      downgradeReasons: Array.isArray(data?.meta?.downgradeReasons) ? data.meta.downgradeReasons : [],
      semanticTrust: semanticTrust || {},
      risk: semanticTrust?.risk || { flags: warnings },
    };
  });

  const aggregate = aggregateSubclaimVerdicts(subclaimOutcomes, {
    confidenceFloor: opts.confidenceFloor,
  });
  const reasoningTrace = buildReasoningTrace({
    claim: statement,
    decomposition,
    subclaimOutcomes,
    aggregate,
    semanticFlags: aggregate.reasons,
  }, { confidenceFloor: opts.confidenceFloor });
  const evidence = subclaimOutcomes.flatMap(item => Array.isArray(item.evidence) ? item.evidence : []);
  return verdict(statement, opts, {
    status: aggregate.status,
    confidence: aggregate.confidence,
  }, evidence, {
    workspaceId,
    decomposition,
    subclaimOutcomes,
    aggregate,
    reasoningTrace,
    trustReceiptPreview: reasoningTrace.trustReceiptPreview,
  });
}

module.exports = { verifyCompound };

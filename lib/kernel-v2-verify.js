'use strict';

const { analyseManipulation } = require('./text-safety-scorer');
const {
  normalizePredicateToken: evidenceNormalizePredicateToken,
  normalizeCopulaTail,
} = require('./kernel-v2-evidence');
const { resolveKnownSubject } = require('./subject-resolution');
const { buildNegationConflict, contradictedBaseVerdict } = require('./kernel-v2-type-negation');
const {
  parseSimpleTurkishStatement,
  resolveNegativeClaimFallback,
} = require('./kernel-v2-native');

/**
 * The v1-escalating verification orchestration: risk-aware statement
 * shaping, parse, early exits through the v1 kernel, subject resolution,
 * the #2117 substitutability rule, the fact-conflict fast path, the base
 * v1 consult, contradiction detail inference, and envelope assembly.
 *
 * Moved verbatim from KernelV2.verify (#2138). Collaborators arrive as an
 * explicit object so this module never reaches into v2 or kernel
 * internals. `v2` and `kernel` are passed through to the leaf seams only
 * (buildNegationConflict, contradictedBaseVerdict,
 * resolveNegativeClaimFallback) -- this module never touches a private of
 * either (asserted by test and by check-module-boundary).
 */
function runVerify(collaborators, statement, opts = {}) {
  const {
    v2,
    kernel,
    verifyBase,
    ok,
    withVerifyDetails,
    buildContradictionDetails,
  } = collaborators;
  const risk = analyseManipulation(statement);
  const verificationStatement = risk.extractedStatement || statement;
  let parsed = parseSimpleTurkishStatement(verificationStatement);
  if (!parsed) return withVerifyDetails(verifyBase(verificationStatement, opts), risk);

  const normalizedTarget = normalizeCopulaTail(parsed.predicate);
  if (!normalizedTarget) return withVerifyDetails(verifyBase(verificationStatement, opts), risk);
  const normalizedTargetToken = evidenceNormalizePredicateToken(normalizedTarget);

  const workspaceId = (typeof opts.workspaceId === 'string' && opts.workspaceId.trim()) || 'default'; // #734
  const resolvedSubject = resolveKnownSubject(kernel.graph, parsed.subject, workspaceId);
  // #2117: KernelV2 substitutes a v1 verdict only through a named rule; see
  // docs/adr/ADR-013-kernel-v2-substitutability.md. Rule: unresolved multi-word subject.
  if (parsed.subject.includes(' ') && !resolvedSubject) return withVerifyDetails(contradictedBaseVerdict(kernel, verificationStatement, opts) || ok('verify', { status: 'unknown', confidence: 0, unresolvedSubject: parsed.subject, subjectResolution: 'exact_match_required' }), risk);
  if (resolvedSubject) parsed = { ...parsed, subject: resolvedSubject };
  // Rule: negated statement vs known fact edge, applied before v1 is consulted.
  const factConflict = buildNegationConflict(v2, parsed, normalizedTarget, normalizedTargetToken, workspaceId, { factsOnly: true });
  if (factConflict) {
    const { evidence: factEvidence, meta: factMeta, ...factData } = factConflict;
    return withVerifyDetails(ok('verify', factData, factEvidence, factMeta), risk);
  }

  const base = verifyBase(verificationStatement, opts);
  if (base?.data?.status !== 'unknown') {
    const contradictionReason = base?.data?.contradictionReason;
    if (base?.data?.status !== 'contradicted' || contradictionReason) {
      if (!(parsed.isNegated && base?.data?.status === 'verified')) return withVerifyDetails(base, risk);
    }
  }
  const contradictionDetails = buildContradictionDetails(
    parsed,
    normalizedTarget,
    normalizedTargetToken,
    opts
  );

  if (!contradictionDetails) {
    return withVerifyDetails(resolveNegativeClaimFallback(kernel, base, verificationStatement, opts, workspaceId, parsed, normalizedTarget), risk);
  }

  const { evidence, meta, ...data } = contradictionDetails;
  return withVerifyDetails(ok(
    'verify',
    {
      ...data,
      ...(data.conflictTarget ? { conflictTarget: data.conflictTarget } : {}),
      ...(data.requestedType ? { requestedType: data.requestedType } : {}),
      ...(data.requestedTarget ? { requestedTarget: data.requestedTarget } : {}),
    },
    evidence,
    {
      ...base.meta,
      ...meta,
    }
  ), risk);
}

module.exports = { runVerify };

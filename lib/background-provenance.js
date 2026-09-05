'use strict';

/**
 * Provenance for writes the system makes on its own behalf.
 *
 * Two paths use this: autonomous mutation (_autoThinkTick, dream, selfEvolve,
 * _crossLink) and the plugin-facing proposeEdge/proposeNode surface. Neither
 * has an external source to attribute, so the provenance is synthetic -- but
 * synthetic is not the same as ungoverned: it is fed into the same admission
 * gate as a user write, and a source the trust policy rates below an
 * unclassified one earns 'review' rather than a silent canonical write.
 *
 * That last sentence used to claim the gate already did this. It did not
 * (#697). The policy computed a confidence, wrote it into provenance, and the
 * admission request carried a hardcoded riskScore of 0, so every source from
 * `llm` to `github` reached the same `allow`. The confidence was accurate
 * metadata attached to a decision it never touched.
 *
 * This lived inline in kernel.js until the trust policy had to be applied here,
 * at which point the file-size ratchet (#328) was correct that it wanted to be
 * its own module rather than another twenty lines of kernel.
 */

const { loadTrustPolicy, applyTrustPolicyToProvenance } = require('./trust-policy');
const { backgroundSponsorship } = require('./human-sponsor-authority');
const { normalizeWorkspaceId } = require('./cli-mutation-audit-intent');

/**
 * @param {string} source            the background source name, e.g. 'autoThink', 'plugin'
 * @param {string} workspaceId
 * @param {object} extra             caller fields; production sponsorship is receiver-owned
 * @param {object} opts
 * @param {string} opts.contractVersion
 * @param {string} [opts.trustPolicyPath]
 * @returns {object} provenance, scored by the trust policy where possible
 */
function buildBackgroundProvenance(source, workspaceId = 'default', extra = {}, opts = {}) {
  const base = sponsorBackgroundProvenance({
    provenanceId: `prov_bg_${source}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    source: `background:${source}`,
    sourceType: 'background_inference',
    sourceRef: `kernel.${source}`,
    actor: `kernel-background:${source}`,
    workspaceId,
    trustPolicyVersion: opts.contractVersion,
    ...extra,
  }, source, workspaceId);

  // Before this, the object above was returned as-is, so these two paths never
  // reached the trust policy at all: no confidence was computed for them, and a
  // plugin edge scored the same as a kernel self-write, which is to say neither
  // was scored. The learn path has always gone through buildProvenance.
  //
  // Guarded on purpose. This runs on autonomous mutation paths, and an
  // unreadable or malformed policy file must not turn a background write into a
  // throw.
  //
  // It must not make the write *easier* to admit either (#741). Returning the
  // unscored object left confidence absent, admissionRiskFromConfidence() maps
  // that to 0, and buildLearnAdmissionRequest() takes it as the policy risk
  // contribution — so a broken or tampered policy file silently downgraded a
  // low-trust background/plugin mutation from REVIEW/QUARANTINE to ALLOW. On
  // failure the write is now scored at a floor below any value the policy could
  // have produced, and the failure is recorded on the provenance so it is
  // auditable rather than invisible.
  try {
    const applied = applyTrustPolicyToProvenance(base, loadTrustPolicy(opts.trustPolicyPath));
    return applied && applied.provenance ? applied.provenance : failClosedProvenance(base);
  } catch (_) {
    return failClosedProvenance(base);
  }
}

// Caller-supplied provenance cannot assert its own production sponsor.
function sponsorBackgroundProvenance(provenance, source, workspaceId) {
  const humanSponsor = backgroundSponsorship(source, workspaceId);
  return humanSponsor ? { ...provenance, workspaceId, humanSponsor } : provenance;
}

/**
 * The provenance-shaped fields a plugin write may carry.
 *
 * Edge `meta` is namespaced and bounded to `entityResolution` by
 * lib/graph-record-utils.js, deliberately, so source-version detail cannot ride
 * there -- and should not: it describes where the claim came from, which is
 * provenance's job. This is the allowlist proposeEdge/proposeNode forward, so a
 * plugin that has pinned its source can say so without every caller re-listing
 * the fields.
 */
function provenanceFieldsFrom(opts = {}) {
  const fields = {
    sourceType: opts.sourceType || 'plugin',
    sourceRef: opts.sourceRef || '',
    actor: opts.actor || opts.sessionId || 'plugin',
  };
  // Absent stays absent: an empty sourceVersion would read as "pinned, to
  // nothing", and an empty contentHash as "hashed, to nothing".
  for (const key of ['sourceSubType', 'sourceVersion', 'sourceVersionKind', 'contentHash', 'contentHashAlgorithm']) {
    if (opts[key]) fields[key] = opts[key];
  }
  return fields;
}

/**
 * The one mapping from a trust-policy confidence to an admission risk score.
 *
 * The admission gate already grades risk -- 85 and above quarantines, 50 and
 * above reviews, below that allows. What was missing is anything putting a
 * number in front of it on these paths, so the ladder was never climbed.
 *
 * The floor is 0.5 because that is what the policy itself assigns a source it
 * cannot classify. Reading it as the pass mark makes the rule statable in one
 * sentence: a source the policy rates no worse than an unknown one is admitted
 * as before, and a source it actively rates *below* unknown is the one that
 * earns review. Under the current policy that is `llm` at 0.4, which maps to
 * 60 and reviews; a hypothetical 0.1 source maps to 90 and quarantines, which
 * is the ladder working rather than a second rule.
 *
 * Deliberately narrow. Mapping every confidence linearly would put today's
 * default plugin write -- sourceType `plugin`, confidence 0.5 -- into review,
 * which is a change to how the product runs rather than a fix to what #697
 * found. That trade is available by lowering nothing but this constant, and it
 * is a decision to take on purpose.
 *
 * An absent or unreadable confidence scores 0: the policy did not rate that
 * write, and inventing risk for it would punish the guarded fallback in
 * buildBackgroundProvenance above, which exists so a malformed policy file
 * cannot turn a background write into a throw.
 */
const UNCLASSIFIED_SOURCE_CONFIDENCE = 0.5;

/**
 * Confidence assigned when the trust policy cannot be loaded or applied (#741).
 *
 * Strictly below every registered default — the strictest is
 * background_inference at 0.3 — so a policy failure can never yield a lower
 * risk than a successful evaluation would have. Applied as a cap, because a
 * caller-supplied confidence would otherwise survive the failure and reopen the
 * same gap.
 */
const TRUST_POLICY_UNAVAILABLE_CONFIDENCE = 0.2;

/**
 * Mark provenance whose trust policy could not be evaluated, and hold it at the
 * failure floor.
 */
function failClosedProvenance(base) {
  const existing = typeof base.confidence === 'number' && Number.isFinite(base.confidence)
    ? base.confidence
    : TRUST_POLICY_UNAVAILABLE_CONFIDENCE;
  return {
    ...base,
    confidence: Math.min(existing, TRUST_POLICY_UNAVAILABLE_CONFIDENCE),
    confidenceSource: 'trust_policy_unavailable',
    trustPolicyStatus: 'unavailable',
  };
}

function admissionRiskFromConfidence(confidence) {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return 0;
  if (confidence >= UNCLASSIFIED_SOURCE_CONFIDENCE) return 0;
  const bounded = Math.max(0, confidence);
  return Math.min(100, Math.round((1 - bounded) * 100));
}

/**
 * K2 (#328, docs/kernel-split-plan.md): admission-gated background edge
 * commit, extracted from Kernel.js as a dependency-injected pure function.
 *
 * FAZ2-PR3 (F-001) behaviour, unchanged:
 *
 * - Builds synthetic provenance describing the background source.
 * - Routes the proposed edge through evaluateLearnAdmission (the same gate
 *   the user-facing learn path uses).
 * - On 'allow': writes the edge with source/provenance metadata and emits
 *   a LEARN audit event tagged background:<source>.
 * - On 'review' or 'reject' (the default for synthetic background
 *   provenance): does NOT write the canonical edge and emits a REVIEW or
 *   REJECT audit event so the attempt is recorded.
 *
 * @param {object} deps
 * @param {function} deps.buildProvenance       (source, workspaceId, extra) => provenance -- defaults to buildBackgroundProvenance
 * @param {function} deps.evaluateLearnAdmission (text, admissionOpts, provenance, workspaceId) => admission|null
 * @param {function} deps.appendAuditEvent      (event, provenance, workspaceId) => audit
 * @param {function} deps.admissionReceiptDetails (admission) => object
 * @param {function} deps.addEdge               (from, to, relation, edgeOptions) => edge
 * @param {string}   [deps.contractVersion]
 * @param {string}   [deps.trustPolicyPath]
 * @returns {function} (from, to, relation, source, opts) => {decision, edge, audit, admission}
 */
function commitBackgroundEdge(deps = {}) {
  const buildProvenance = deps.buildProvenance || buildBackgroundProvenance;
  const evaluateLearnAdmission = deps.evaluateLearnAdmission;
  const appendAuditEvent = deps.appendAuditEvent;
  const admissionReceiptDetails = deps.admissionReceiptDetails;
  const addEdge = deps.addEdge;
  const contractVersion = deps.contractVersion;
  const trustPolicyPath = deps.trustPolicyPath;
  if (typeof evaluateLearnAdmission !== 'function' ||
    typeof appendAuditEvent !== 'function') {
    // Fail-closed: without the admission gate there is no safe write path.
    throw new Error('commitBackgroundEdge requires deps.evaluateLearnAdmission and deps.appendAuditEvent');
  }
  return function commitBackgroundEdge(from, to, relation, source, opts = {}) {
    const workspaceId = normalizeWorkspaceId(opts.workspaceId || 'default');
    const provenance = buildProvenance(source, workspaceId, opts.provenanceExtra || {}, {
      contractVersion,
      trustPolicyPath,
    });
    const proposalText = `${from} ${relation} ${to}`;
    const admissionOpts = {
      ...(opts.admissionOpts || {}),
      workspaceId,
      provenanceId: provenance.provenanceId,
      actor: provenance.actor,
      agentId: provenance.actor,
      sourceType: provenance.sourceType,
      sourceRef: provenance.sourceRef,
      admissionReason: `background_${source}_edge_write`,
      admissionContext: {
        ...(opts.admissionOpts && opts.admissionOpts.admissionContext) || {},
        backgroundSource: source,
      },
    };
    const admission = evaluateLearnAdmission(proposalText, admissionOpts, provenance, workspaceId);

    // An operator-directed local bypass is expressed as an explicit
    // admissionOpts.admissionBypassReason on the *calling* opts (e.g. the
    // dream { learnFromDream, admissionOpts } passthrough). In that case
    // _evaluateLearnAdmission honours the bypass and returns null; we turn
    // that null into an allow here so the requested write actually lands.
    // Without this explicit reason, admission stays null and the write is
    // fail-closed (review) below — default behaviour is unchanged and the
    // F-001 guard (no default bypass injection) is preserved.
    const explicitBypassRequested = Boolean(
      opts && opts.admissionOpts &&
      typeof opts.admissionOpts.admissionBypassReason === 'string' &&
      opts.admissionOpts.admissionBypassReason.trim().length > 0,
    );
    const resolvedAdmission = (!admission && explicitBypassRequested)
      ? {
          outcome: 'allow',
          reason: 'local_admission_bypass_requested',
          graphWrite: true,
          workspaceId,
          approvalStatus: 'approved',
          provenanceId: provenance ? provenance.provenanceId : null,
        }
      : admission;

    if (!resolvedAdmission) {
      const audit = appendAuditEvent({
        eventType: 'REVIEW',
        targetType: 'background_edge',
        targetId: `${from}|${relation}|${to}`,
        details: {
          backgroundSource: source,
          reason: 'admission_unavailable',
          from,
          to,
          relation,
        },
      }, provenance, workspaceId);
      return { decision: 'review', edge: null, audit, admission: null };
    }
    if (resolvedAdmission.outcome !== 'allow') {
      const audit = appendAuditEvent({
        eventType: resolvedAdmission.outcome === 'reject' ? 'REJECT' : 'REVIEW',
        targetType: 'background_edge',
        targetId: `${from}|${relation}|${to}`,
        details: {
          backgroundSource: source,
          reason: resolvedAdmission.reason,
          admissionOutcome: resolvedAdmission.outcome,
          approvalStatus: resolvedAdmission.approvalStatus,
          ...(admissionReceiptDetails ? admissionReceiptDetails(resolvedAdmission) : {}),
          from,
          to,
          relation,
        },
      }, provenance, workspaceId);
      return { decision: resolvedAdmission.outcome, edge: null, audit, admission: resolvedAdmission };
    }
    const edgeOptions = {
      ...(opts.edgeOptions || {}),
      workspaceId,
      provenance,
      source: opts.edgeOptions && opts.edgeOptions.source
        ? opts.edgeOptions.source
        : `background:${source}`,
    };
    const edge = addEdge ? addEdge(from, to, relation, edgeOptions) : null;
    const audit = appendAuditEvent({
      eventType: 'LEARN',
      targetType: 'background_edge',
      targetId: edge ? `${edge.from}|${edge.relation}|${edge.to}` : `${from}|${relation}|${to}`,
      details: {
        backgroundSource: source,
        from,
        to,
        relation,
        admissionOutcome: 'allow',
        ...(admissionReceiptDetails ? admissionReceiptDetails(resolvedAdmission) : {}),
      },
    }, provenance, workspaceId);
    return { decision: 'allow', edge, audit, admission: resolvedAdmission };
  };
}

module.exports = {
  UNCLASSIFIED_SOURCE_CONFIDENCE,
  TRUST_POLICY_UNAVAILABLE_CONFIDENCE,
  admissionRiskFromConfidence,
  buildBackgroundProvenance,
  sponsorBackgroundProvenance,
  provenanceFieldsFrom,
  commitBackgroundEdge,
};

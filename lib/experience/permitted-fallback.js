'use strict';

/**
 * Experience — Permitted Fallback (#2398, design comment on #2385, R3
 * Phase 9).
 *
 * Runtime delivery of #2385's design: a caller-side permission check for
 * escalating past a router refusal (#2395, `no_structural_match` /
 * `no_eligible_match`) or a PEM environment-fingerprint refusal (#2396,
 * `environment_fingerprint_mismatch`) into LLM-assisted discovery. Pure
 * permission and labelling logic — no model call happens in this file, no
 * model call happens anywhere reachable from it. The caller decides whether
 * to actually invoke a model only after `evaluateFallbackPermission()`
 * returns `allowed: true`.
 *
 * ## Structural default-deny
 *
 * `evaluateFallbackPermission()` requires `priorRefusalReason` to already be
 * one of the router's or PEM's own refusal codes — a caller that has not
 * seen a refusal cannot construct a valid call. Neither `router.js` nor
 * `personal-execution-model.js` import this module, and this module imports
 * them only for the closed, versioned refusal vocabulary, never for routing
 * — no "or fall back" branch exists in either.
 *
 * ## Permission model
 *
 * A **standing grant** is `(workspaceId, capabilityClass, maxRiskTier)`,
 * receipted, with a **mandatory** `expiresAt` — no permanent standing
 * grant is representable in this data shape. A **per-run token** is a
 * single-use grant scoped to one `runId`, consumed on first use; a second
 * attempt with the same token is refused, not silently re-granted.
 * `maxRiskTier` reuses `lib/agent-identity-runtime.js`'s `risk_tier`
 * vocabulary verbatim (`low/medium/high/critical`).
 *
 * ## Labelling that survives
 *
 * `provenanceSource: 'deterministic' | 'permitted_fallback'` is the field
 * this module makes mechanical, not conventional, across three hops:
 *
 * - **Receipts** — `buildFallbackReceiptPayload()` builds the unmodified
 *   canonical payload via `lib/receipt/canonical-receipt.js`'s own
 *   `buildCanonicalReceiptPayload()`, then layers `provenanceSource`
 *   alongside it, and throws if the field is not supplied explicitly.
 *   `canonical-receipt.js` itself is untouched: an earlier attempt added
 *   `provenanceSource` to the shared, hashed canonical schema directly and
 *   broke `test/receipt-trust-root-4-migration-compatibility.test.js` and
 *   sibling suites that pin that schema's hash in fixtures — resolved by
 *   keeping the field outside the hashed shape instead.
 * - **Memory admission** — `lib/memory-admission-gate.js` gained a small,
 *   additive `provenanceSource` pass-through, validated and surfaced on the
 *   receipt's `metadata`; `isPermittedFallbackSignal()` below reads it,
 *   parallel to the gate's own `isQuarantineSignal()` — same shape,
 *   different trigger — so a fallback-sourced fact is tagged, never
 *   silently indistinguishable from a deterministic one.
 * - **Experience events** — `lib/experience/contract.js` treats an event's
 *   payload as opaque by design, so no schema change was needed there:
 *   `provenanceSource` is a required key this module always sets on the
 *   `action_proposed` / `run_closed` payloads it builds
 *   (`buildFallbackActionProposedPayload()` /
 *   `buildFallbackRunClosedPayload()`). Resolved ambiguity, not a silent
 *   guess: contract.js's own "payload is opaque" rule already makes the
 *   field mechanical once every payload-building call site here sets it.
 *
 * ## Effect table — no fallback-specific bypass
 *
 * Read-only fallback answers are allowed within the granted risk tier
 * (caller responsibility, not enforced here — there is nothing to enforce
 * against for a pure read). A fallback-sourced mutation or external action
 * is routed through the existing `lib/agent-action-firewall.js` exactly as
 * a deterministic action would be: `evaluateFallbackAction()` below is a
 * thin wrapper that tags `context.provenanceSource` and otherwise changes
 * nothing about `evaluateAgentActionFirewall()`'s own decision logic — no
 * fallback-specific allow path exists to bypass it.
 *
 * The anti-erosion mechanism (`fallbackPreferredOverCount` on the Capability
 * Trust record) and the learning-admission / paranoid-promotion rules split
 * into `./permitted-fallback-trust.js`, kept out of this file to stay under
 * the ~400-line module budget — see that file's own doc.
 */

const crypto = require('node:crypto');

const { REFUSAL_REASONS: ROUTER_REFUSAL_REASONS } = require('./router');
const { evaluateAgentActionFirewall } = require('../agent-action-firewall');
const { buildCanonicalReceiptPayload } = require('../receipt/canonical-receipt');

const FALLBACK_SCHEMA_VERSION = 'huqan-permitted-fallback-v1';

const PROVENANCE_SOURCES = Object.freeze({
  DETERMINISTIC: 'deterministic',
  PERMITTED_FALLBACK: 'permitted_fallback',
});

/**
 * Extends the router's own refusal vocabulary (#2395) with the one new
 * reason this delivery adds, per the design comment: "same `refusalReason`
 * vocabulary, extended with `fallback_not_permitted`." Not a second
 * vocabulary — `router.js`'s `REFUSAL_REASONS` is unmodified; this is an
 * additive companion object a caller reads alongside it.
 */
const FALLBACK_REFUSAL_REASONS = Object.freeze({
  FALLBACK_NOT_PERMITTED: 'fallback_not_permitted',
});

// PEM's refusal code (#2396) is not exported as a named constant there, so
// it is named here as a literal matching the exact string that module returns.
const PEM_ENVIRONMENT_FINGERPRINT_MISMATCH = 'environment_fingerprint_mismatch';

/** The only refusal codes that may even ask "is fallback permitted here." */
const VALID_PRIOR_REFUSALS = Object.freeze(new Set([
  ROUTER_REFUSAL_REASONS.NO_STRUCTURAL_MATCH,
  ROUTER_REFUSAL_REASONS.NO_ELIGIBLE_MATCH,
  PEM_ENVIRONMENT_FINGERPRINT_MISMATCH,
]));

// Reused verbatim from lib/agent-identity-runtime.js's RISK_ORDER — not
// reinvented here.
const RISK_ORDER = Object.freeze({
  low: 0, medium: 1, high: 2, critical: 3,
});

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function refuse(code, extra = {}) {
  return {
    ok: false,
    allowed: false,
    refusalReason: FALLBACK_REFUSAL_REASONS.FALLBACK_NOT_PERMITTED,
    code,
    ...extra,
  };
}

/** Required-field guard for `provenanceSource`; throws rather than defaulting. */
function assertProvenanceSource(value) {
  if (value !== PROVENANCE_SOURCES.DETERMINISTIC && value !== PROVENANCE_SOURCES.PERMITTED_FALLBACK) {
    const err = new Error(
      `provenanceSource must be 'deterministic' or 'permitted_fallback' (got: ${JSON.stringify(value)})`,
    );
    err.code = 'PROVENANCE_SOURCE_INVALID';
    throw err;
  }
  return value;
}

/** Standing grant, receipted, with a mandatory `expiresAt` — refuses to
 * build without a parseable expiry (module doc). */
function createStandingGrant({
  workspaceId, capabilityClass, maxRiskTier, grantedBy, expiresAt, reason = null, at = nowIso(),
} = {}) {
  if (!nonEmptyString(workspaceId) || !nonEmptyString(capabilityClass)
    || !Object.hasOwn(RISK_ORDER, maxRiskTier) || !nonEmptyString(grantedBy)
    || !nonEmptyString(expiresAt) || Number.isNaN(Date.parse(expiresAt))) {
    return { ok: false, code: 'invalid_standing_grant' };
  }
  const grantId = `pfg_${sha256([workspaceId, capabilityClass, maxRiskTier, grantedBy, expiresAt, at].join('|')).slice(0, 32)}`;
  const grant = Object.freeze({
    kind: 'standing',
    grantId,
    workspaceId,
    capabilityClass,
    maxRiskTier,
    grantedBy,
    reason: nonEmptyString(reason) ? reason : null,
    grantedAt: at,
    expiresAt,
    // A grant is itself receipted: who granted it, at what scope, when —
    // mirroring human-approval-toggle.js's "switching it is itself a
    // receipt" rule.
    receipt: Object.freeze({
      receiptKind: 'permitted_fallback_grant_receipt',
      grantId,
      grantedBy,
      workspaceId,
      capabilityClass,
      maxRiskTier,
      reason: nonEmptyString(reason) ? reason : null,
      grantedAt: at,
      expiresAt,
    }),
  });
  return { ok: true, grant };
}

/** Single-use per-run token, scoped to one `runId`. */
function createPerRunToken({
  workspaceId, capabilityClass, maxRiskTier, runId, grantedBy, at = nowIso(),
} = {}) {
  if (!nonEmptyString(workspaceId) || !nonEmptyString(capabilityClass)
    || !Object.hasOwn(RISK_ORDER, maxRiskTier) || !nonEmptyString(runId) || !nonEmptyString(grantedBy)) {
    return { ok: false, code: 'invalid_per_run_token' };
  }
  const tokenId = `pft_${sha256([workspaceId, capabilityClass, maxRiskTier, runId, grantedBy, at].join('|')).slice(0, 32)}`;
  const token = Object.freeze({
    kind: 'per_run',
    tokenId,
    workspaceId,
    capabilityClass,
    maxRiskTier,
    runId,
    grantedBy,
    grantedAt: at,
    receipt: Object.freeze({
      receiptKind: 'permitted_fallback_token_receipt',
      tokenId,
      grantedBy,
      workspaceId,
      capabilityClass,
      runId,
      grantedAt: at,
    }),
  });
  return { ok: true, token };
}

/**
 * Caller-held permission registry, same shape convention as
 * `createLearningPool()` / `createCapabilityTrustRegistry()`: in-memory,
 * durable storage is a separate concern left to whoever wires this in.
 */
function createPermittedFallbackRegistry() {
  const standingGrants = new Map();
  const tokens = new Map();

  function registerStandingGrant(args) {
    const built = createStandingGrant(args);
    if (!built.ok) return built;
    standingGrants.set(built.grant.grantId, built.grant);
    return built;
  }

  function registerPerRunToken(args) {
    const built = createPerRunToken(args);
    if (!built.ok) return built;
    tokens.set(built.token.tokenId, { token: built.token, consumed: false, consumedAt: null });
    return built;
  }

  function findStandingGrant({
    workspaceId, capabilityClass, riskTier, now,
  }) {
    const nowMs = Date.parse(now);
    for (const grant of standingGrants.values()) {
      if (grant.workspaceId !== workspaceId) continue;
      if (grant.capabilityClass !== capabilityClass) continue;
      if (RISK_ORDER[riskTier] > RISK_ORDER[grant.maxRiskTier]) continue;
      // Past-expiry refuses, not warns (acceptance test 9): a grant whose
      // expiry has already passed is treated identically to no grant.
      if (Number.isNaN(nowMs) || Date.parse(grant.expiresAt) <= nowMs) continue;
      return grant;
    }
    return null;
  }

  function consumeToken({
    tokenId, workspaceId, capabilityClass, riskTier, runId,
  }) {
    const entry = tokens.get(tokenId);
    if (!entry) return { ok: false, code: 'unknown_token' };
    if (entry.consumed) return { ok: false, code: 'token_already_consumed' };
    const { token } = entry;
    if (token.workspaceId !== workspaceId || token.capabilityClass !== capabilityClass
      || token.runId !== runId || RISK_ORDER[riskTier] > RISK_ORDER[token.maxRiskTier]) {
      return { ok: false, code: 'token_scope_mismatch' };
    }
    entry.consumed = true;
    entry.consumedAt = nowIso();
    return { ok: true, token };
  }

  /**
   * The single decision seam: refuse before any model call unless a grant
   * or an unconsumed token applies. `priorRefusalReason` must already be one
   * of the router's/PEM's own refusal codes (module doc) — this is checked
   * first, before any grant lookup, so an out-of-sequence call is refused
   * identically to an unpermitted one.
   */
  function evaluateFallbackPermission({
    workspaceId, capabilityClass, riskTier, runId, priorRefusalReason, tokenId, now = nowIso(),
  } = {}) {
    if (!VALID_PRIOR_REFUSALS.has(priorRefusalReason)) {
      return refuse('fallback_checked_without_prior_refusal');
    }
    if (!nonEmptyString(workspaceId) || !nonEmptyString(capabilityClass)
      || !Object.hasOwn(RISK_ORDER, riskTier)) {
      return refuse('invalid_fallback_request');
    }
    if (nonEmptyString(tokenId)) {
      const consumed = consumeToken({
        tokenId, workspaceId, capabilityClass, riskTier, runId,
      });
      if (!consumed.ok) return refuse(consumed.code);
      return {
        ok: true, allowed: true, grantKind: 'per_run', grant: consumed.token,
      };
    }
    const grant = findStandingGrant({
      workspaceId, capabilityClass, riskTier, now,
    });
    if (!grant) return refuse('no_grant');
    return {
      ok: true, allowed: true, grantKind: 'standing', grant,
    };
  }

  return Object.freeze({
    registerStandingGrant,
    registerPerRunToken,
    evaluateFallbackPermission,
  });
}

/** Fallback-sourced receipt construction: builds the unmodified canonical
 * payload, then layers `provenanceSource` alongside it (not inside the
 * hashed canonical shape — see module doc). Throws if omitted. */
function buildFallbackReceiptPayload(receipt, { verdict, provenanceSource } = {}) {
  if (provenanceSource === undefined) {
    const err = new Error(
      'buildFallbackReceiptPayload requires opts.provenanceSource to be set explicitly',
    );
    err.code = 'PROVENANCE_SOURCE_REQUIRED';
    throw err;
  }
  assertProvenanceSource(provenanceSource);
  const canonicalPayload = buildCanonicalReceiptPayload(receipt, { verdict });
  return Object.freeze({ ...canonicalPayload, provenanceSource });
}

/** Parallel to isQuarantineSignal() (memory-admission-gate.js): same shape,
 * different trigger. */
function isPermittedFallbackSignal(request = {}) {
  return isRecord(request) && request.provenanceSource === PROVENANCE_SOURCES.PERMITTED_FALLBACK;
}

/** Experience `action_proposed` payload fragment carrying provenance. */
function buildFallbackActionProposedPayload(base = {}, provenanceSource) {
  assertProvenanceSource(provenanceSource);
  return Object.freeze({ ...base, provenanceSource });
}

/** Experience `run_closed` payload fragment carrying provenance (#2396's
 * `modelId` sits alongside this the same way). */
function buildFallbackRunClosedPayload(base = {}, provenanceSource) {
  assertProvenanceSource(provenanceSource);
  return Object.freeze({ ...base, provenanceSource });
}

/**
 * A fallback-sourced action enters the existing firewall exactly like any
 * other proposed action — no bypass, no fallback-specific allow path. Only
 * change from calling `evaluateAgentActionFirewall()` directly: the
 * provenance tag rides along on `context` and the returned metadata, so it
 * is visible on whatever the firewall's own decision/telemetry records.
 */
function evaluateFallbackAction(request = {}) {
  const provenanceSource = assertProvenanceSource(
    request.provenanceSource || PROVENANCE_SOURCES.PERMITTED_FALLBACK,
  );
  const decision = evaluateAgentActionFirewall({
    ...request,
    context: { ...(request.context || {}), provenanceSource },
  });
  return {
    ...decision,
    metadata: { ...(decision.metadata || {}), provenanceSource },
  };
}

module.exports = Object.freeze({
  PROVENANCE_SOURCES,
  FALLBACK_REFUSAL_REASONS,
  VALID_PRIOR_REFUSALS,
  RISK_ORDER,
  isRecord,
  nonEmptyString,
  assertProvenanceSource,
  createStandingGrant,
  createPerRunToken,
  createPermittedFallbackRegistry,
  buildFallbackReceiptPayload,
  buildFallbackActionProposedPayload,
  buildFallbackRunClosedPayload,
  evaluateFallbackAction,
  isPermittedFallbackSignal,
});

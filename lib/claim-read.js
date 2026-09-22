'use strict';

/**
 * A risk-scoped read of one claim/target through the contested-read policy
 * (#2788): wraps lib/provenance-query.js's queryTrustGraph() -- unmodified --
 * and, when the target is actively contested by a candidate claim from
 * lib/conflict-detector.js, resolves how it is served from the reader's
 * declared risk class (lib/contested-read-policy.js) instead of always
 * handing back the canonical value as settled.
 *
 * The return value is a frozen, discriminated union keyed on `kind`
 * (`'settled' | 'unsettled' | 'not_found'`), not an optional field on the
 * ordinary Trust Receipt: the ATP 0.1 receipt schema
 * (specs/axiom-trust-protocol/0.1/schemas/trust-receipt.schema.json) is
 * frozen and requires `claim: string`, so a contested/blocked read cannot be
 * expressed by omitting or nulling a receipt field. `unwrapClaimRead` is the
 * only way to reach a value from an `unsettled` result, so a caller that
 * ignores the branch fails loudly instead of silently treating a contested
 * or blocked read as settled.
 *
 * See docs/contested-read-policy.md for the full policy and the two design
 * decisions this implements (#2788 issuecomment-5784967135,
 * issuecomment-5784993182).
 */

const { queryTrustGraph } = require('./provenance-query');
const {
  CONTESTED_READ_POLICY_VERSION,
  READ_BEHAVIORS,
  resolveReaderRiskLevel,
  selectReadBehavior,
  isContestingCandidate,
} = require('./contested-read-policy');

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

class ClaimReadUnsettledError extends Error {
  constructor(message, { code, reason, behavior }) {
    super(message);
    this.name = 'ClaimReadUnsettledError';
    this.code = code;
    this.reason = reason;
    this.behavior = behavior;
  }
}

function minimalReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') return null;
  return Object.freeze({ id: receipt.receiptId, status: receipt.status });
}

function ledgerEvent(type, { workspaceId, targetId, behavior, reason }) {
  return Object.freeze({
    type,
    workspaceId,
    targetId,
    behavior,
    reason: reason || null,
    occurredAt: new Date().toISOString(),
  });
}

/**
 * Read one target through the contested-read policy.
 *
 * @param {object} kernelOrTarget a Kernel or Graph -- forwarded to
 *   queryTrustGraph() unchanged, which already accepts either.
 * @param {object} opts
 * @param {string} opts.workspaceId
 * @param {string} opts.targetId
 * @param {object} [opts.intent] `{category}` and/or `{riskScore}` and/or
 *   `{blastRadius}` describing the risk class of the action the caller is
 *   about to take with the value. Missing/unrecognized intent is a fail-safe
 *   `block`, per docs/action-taxonomy.md §4.
 * @returns {object} a frozen `{kind: 'settled'|'unsettled'|'not_found', ...}`
 */
function readClaim(kernelOrTarget, opts = {}) {
  const { workspaceId, targetId, intent } = opts;
  const result = queryTrustGraph(kernelOrTarget, { workspaceId, targetId });
  const { canonical, candidateClaims, receipt } = result;

  if (!canonical) {
    return deepFreeze({
      kind: 'not_found',
      policyVersion: CONTESTED_READ_POLICY_VERSION,
      workspaceId: result.workspaceId,
      targetId,
    });
  }

  const challengers = candidateClaims.filter((candidate) => isContestingCandidate(candidate, canonical));

  if (challengers.length === 0) {
    return deepFreeze({
      kind: 'settled',
      value: canonical,
      receipt,
      policyVersion: CONTESTED_READ_POLICY_VERSION,
      workspaceId: result.workspaceId,
      targetId,
    });
  }

  const resolution = resolveReaderRiskLevel(intent);
  const { behavior, reason } = selectReadBehavior(resolution, { hasLastKnownGood: Boolean(canonical) });
  const reader = Object.freeze({ riskLevel: resolution.level, source: resolution.source });
  const base = {
    kind: 'unsettled',
    reason,
    behavior,
    reader,
    policyVersion: CONTESTED_READ_POLICY_VERSION,
    workspaceId: result.workspaceId,
    targetId,
  };

  if (behavior === READ_BEHAVIORS.BLOCK) {
    return deepFreeze({
      ...base,
      receipt: minimalReceipt(receipt),
      ledgerEvents: [ledgerEvent('claim_read_blocked', { workspaceId: result.workspaceId, targetId, behavior, reason })],
    });
  }

  if (behavior === READ_BEHAVIORS.LAST_KNOWN_GOOD) {
    return deepFreeze({
      ...base,
      lastKnownGood: canonical,
      receipt,
      ledgerEvents: [ledgerEvent('claim_read_last_known_good', { workspaceId: result.workspaceId, targetId, behavior, reason })],
    });
  }

  // READ_BEHAVIORS.CONTESTED_MARKER
  return deepFreeze({
    ...base,
    sides: { canonical, challengers },
    receipt,
    ledgerEvents: [ledgerEvent('claim_read_unsettled', { workspaceId: result.workspaceId, targetId, behavior, reason })],
  });
}

/**
 * Unwrap a readClaim() result to its value, or throw.
 *
 * - `settled` always returns `value`.
 * - `unsettled` with `behavior: 'block'` always throws
 *   (`code: 'CLAIM_READ_BLOCKED'`) -- block is never acceptable to unwrap
 *   past, regardless of `accept`.
 * - `unsettled` with any other behavior returns the matching payload
 *   (`lastKnownGood` or `sides`) only if that behavior is listed in
 *   `opts.accept`; otherwise throws (`code: 'CLAIM_UNSETTLED'`). This is the
 *   explicit, reviewable decision #2788 asks for: the call site names which
 *   degraded behaviors it is willing to act on.
 * - `not_found` returns `undefined`.
 */
function unwrapClaimRead(result, { accept = [] } = {}) {
  if (!result || typeof result !== 'object') {
    throw new TypeError('unwrapClaimRead requires a readClaim() result');
  }

  if (result.kind === 'settled') return result.value;
  if (result.kind === 'not_found') return undefined;

  if (result.kind === 'unsettled') {
    if (result.behavior === READ_BEHAVIORS.BLOCK) {
      throw new ClaimReadUnsettledError(
        `claim read blocked for target "${result.targetId}" (reason: ${result.reason})`,
        { code: 'CLAIM_READ_BLOCKED', reason: result.reason, behavior: result.behavior },
      );
    }
    if (accept.includes(result.behavior)) {
      return result.behavior === READ_BEHAVIORS.LAST_KNOWN_GOOD ? result.lastKnownGood : result.sides;
    }
    throw new ClaimReadUnsettledError(
      `claim read unsettled for target "${result.targetId}" (behavior: ${result.behavior}, not in accept list)`,
      { code: 'CLAIM_UNSETTLED', reason: result.reason, behavior: result.behavior },
    );
  }

  throw new TypeError(`unwrapClaimRead: unrecognized result kind "${result.kind}"`);
}

module.exports = {
  CLAIM_READ_POLICY_VERSION: CONTESTED_READ_POLICY_VERSION,
  readClaim,
  unwrapClaimRead,
  ClaimReadUnsettledError,
};

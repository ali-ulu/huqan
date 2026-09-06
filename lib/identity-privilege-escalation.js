'use strict';

/**
 * #1891 — privilege-escalation detector for the external action guard.
 *
 * `lib/external-action-identity.js` answers one question per call: does the
 * card presented *now* grant the capability being exercised *now*
 * (`grantsCapability`). That check is correct and stays where it is, but it is
 * memoryless. An agent that presents `capabilities: ['tool']` on its first
 * call and `['tool', 'deployment', 'shell']` on its twentieth passes both
 * checks individually, and nothing anywhere notices that the authority it
 * claims grew mid-session. Widening a card is exactly what a compromised or
 * confused agent does, and it was invisible.
 *
 * This module is the missing memory: per session, per identity, the union of
 * every capability that identity has claimed so far. A card presenting a
 * capability the session has never held before is an escalation.
 *
 * ## What it deliberately does not do
 *
 * It does not decide. It reports `escalated` plus the capabilities that were
 * added, and the guard maps that to a decision — the same split every other
 * gate in this codebase uses, so a detector can never silently relax a verdict
 * another gate already reached.
 *
 * It is also not a signature check. A widened card that is properly signed is
 * still a widened card; whether the widening was authorized is a question for
 * the human sponsor, which is why the honest output is `review` rather than a
 * confident block.
 *
 * ## Session-scoped, not durable
 *
 * The ledger lives in memory and is bounded (`maxSessions`, LRU). A restart
 * loses history, and an evicted session reads as a fresh baseline. That is a
 * real limit and it is the honest one: the alternative — a new durable table —
 * would claim cross-restart coverage this does not have. A session that was
 * evicted reports a baseline, never a false escalation.
 */

const PRIVILEGE_ESCALATION_REASON = 'agent_identity_privilege_escalation';
const DEFAULT_MAX_SESSIONS = 512;
const MAX_TRACKED_CAPABILITIES = 64;

function boundedText(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

/**
 * Deduplicates while preserving the order the caller presented, so
 * `addedCapabilities` reads back in the order it appeared on the card rather
 * than in an order this module invented.
 */
function normalizeCapabilities(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const capability = boundedText(item);
    if (!capability || seen.has(capability)) continue;
    seen.add(capability);
    out.push(capability);
    if (out.length >= MAX_TRACKED_CAPABILITIES) break;
  }
  return out;
}

/**
 * A bounded LRU of sessions. `size` counts sessions, not identities: the bound
 * exists to cap memory against unbounded session churn, and an identity only
 * ever exists inside a session it was seen in.
 */
function createEscalationLedger({ maxSessions = DEFAULT_MAX_SESSIONS } = {}) {
  const limit = Number.isInteger(maxSessions) && maxSessions > 0 ? maxSessions : DEFAULT_MAX_SESSIONS;
  const sessions = new Map();

  return Object.freeze({
    get size() {
      return sessions.size;
    },
    /** Moves the session to the most-recent end and returns its identity map. */
    touch(sessionId) {
      const existing = sessions.get(sessionId);
      if (existing) {
        sessions.delete(sessionId);
        sessions.set(sessionId, existing);
        return existing;
      }
      const created = new Map();
      sessions.set(sessionId, created);
      while (sessions.size > limit) {
        const oldest = sessions.keys().next();
        if (oldest.done) break;
        sessions.delete(oldest.value);
      }
      return created;
    },
  });
}

function untracked(observedCapabilities) {
  return Object.freeze({
    tracked: false,
    escalated: false,
    reason: null,
    addedCapabilities: Object.freeze([]),
    priorCapabilities: Object.freeze([]),
    observedCapabilities: Object.freeze(observedCapabilities),
  });
}

/**
 * Records one identity observation and reports whether it widened the session's
 * authority.
 *
 * The comparison is against the union of everything the identity has claimed in
 * this session, not against the immediately preceding card. Comparing to the
 * previous card only would let an agent alternate between two cards forever and
 * register an escalation on every other call, which is noise rather than
 * signal.
 *
 * @returns {{tracked: boolean, escalated: boolean, reason: string|null,
 *            addedCapabilities: string[], priorCapabilities: string[],
 *            observedCapabilities: string[]}}
 */
function observeIdentityScope(ledger, { sessionId, identityRef, capabilities } = {}) {
  const observedCapabilities = normalizeCapabilities(capabilities);
  const session = boundedText(sessionId);
  const identity = boundedText(identityRef);

  // Without both keys there is nothing to accumulate against. Reporting this as
  // `tracked: false` keeps it distinguishable from "tracked, and clean" — an
  // unidentified call is missing evidence, not evidence of good behaviour.
  if (!session || !identity || !ledger || typeof ledger.touch !== 'function') {
    return untracked(observedCapabilities);
  }

  const identities = ledger.touch(session);
  const held = identities.get(identity) || new Set();
  const added = observedCapabilities.filter((capability) => !held.has(capability));
  // A first sighting establishes the baseline; it is not a widening of anything.
  const escalated = held.size > 0 && added.length > 0;
  const priorCapabilities = [...held];

  for (const capability of added) {
    if (held.size >= MAX_TRACKED_CAPABILITIES) break;
    held.add(capability);
  }
  identities.set(identity, held);

  return Object.freeze({
    tracked: true,
    escalated,
    reason: escalated ? PRIVILEGE_ESCALATION_REASON : null,
    addedCapabilities: Object.freeze(escalated ? added : []),
    priorCapabilities: Object.freeze(priorCapabilities),
    observedCapabilities: Object.freeze(observedCapabilities),
  });
}

/**
 * Opt-in, in the shape AB12 established: with nothing configured this returns
 * null and the guard's behaviour is byte-identical to before. A detector that
 * turned itself on would add a `review` to deployments that never asked for
 * one, and a gate nobody opted into producing a verdict is how a safety feature
 * becomes something operators route around.
 *
 * `review` is the default verdict rather than `block` because a widened card
 * may be legitimate re-issuance; the honest answer is "a human should look",
 * not "this is an attack". A deployment that wants it fatal sets `block`.
 *
 * ## Why the default ledger is shared
 *
 * `privilegeEscalationOptions` is called once per guarded action, not once per
 * process. Building a fresh ledger here would reset the session history on
 * every call, and a detector that can never accumulate is worse than none: the
 * flag would read as enabled while the check was structurally incapable of
 * firing. The default is therefore a module-level ledger, bounded by the same
 * LRU. A caller that wants isolation (tests, or two guards that must not see
 * each other's sessions) passes its own `ledger`.
 */
const defaultLedger = createEscalationLedger();
function privilegeEscalationOptions(options = {}) {
  const supplied = options.privilegeEscalation;
  const configured = supplied !== null && typeof supplied === 'object';
  if (configured && supplied.enabled === false) return null;

  let decision = null;
  if (configured && supplied.enabled === true) {
    decision = supplied.decision === 'block' ? 'block' : 'review';
  } else {
    const environment = options.environment || process.env;
    const flag = String(environment.HUQAN_EXTERNAL_GUARD_PRIVILEGE_ESCALATION || '').trim().toLowerCase();
    if (flag === 'block') decision = 'block';
    else if (['1', 'true', 'review', 'enable', 'require'].includes(flag)) decision = 'review';
  }
  if (!decision) return null;

  return Object.freeze({
    decision,
    ledger: (configured && supplied.ledger) || defaultLedger,
  });
}

/**
 * Records this invocation's claimed authority and returns a gate finding only
 * when it widened. Returning null for the ordinary case keeps the findings
 * array free of a per-call entry that always says "nothing happened".
 *
 * @returns {object|null}
 */
function evaluateIdentityEscalation({ envelope, identity } = {}, config = null) {
  if (!config || !identity) return null;

  const result = observeIdentityScope(config.ledger, {
    sessionId: envelope?.session?.id,
    identityRef: identity.identityRef,
    capabilities: identity.capabilities,
  });
  if (!result.escalated) return null;

  return Object.freeze({
    gate: 'identity-escalation',
    decision: config.decision,
    reason: PRIVILEGE_ESCALATION_REASON,
    identityRef: identity.identityRef,
    identityHash: identity.identityHash,
    attested: identity.attested === true,
    addedCapabilities: result.addedCapabilities,
    priorCapabilities: result.priorCapabilities,
  });
}

module.exports = {
  PRIVILEGE_ESCALATION_REASON,
  DEFAULT_MAX_SESSIONS,
  MAX_TRACKED_CAPABILITIES,
  createEscalationLedger,
  observeIdentityScope,
  privilegeEscalationOptions,
  evaluateIdentityEscalation,
};

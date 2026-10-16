'use strict';

/**
 * Experience Phase 4 — learning admission and procedure candidates (#2390).
 *
 * The narrow core of the Learning Runtime: eligible immutable Experience
 * becomes a LearningRecord, and LearningRecords become procedure
 * candidates. Nothing here activates anything — no policy change, no trust
 * promotion, no procedure registration. A candidate is data with a
 * `candidate` status; the human/policy admission and the Procedure
 * Registry (Phase 6) are separate deliveries that consume it.
 *
 * ## Why not reuse the hypothesis-* surfaces directly
 *
 * `lib/hypothesis-review.js`, `hypothesis-feedback.js` and
 * `hypothesis-fitness.js` run the graph conflict-detection loop: they
 * propose, review and score candidate claims about graph edges. Their
 * candidates, verdicts and fitness have graph shapes. LearningRecords
 * carry run shapes (source hashes, scope, eligibility) and answer a
 * different question — "what may be learned from this run?" — so they get
 * their own pool. The two loops meet at the existing human review: a
 * procedure candidate, like any candidate, moves only on a person's
 * verdict, and this module never records one.
 *
 * ## Admission rules
 *
 * - `positive_procedure` → positive pool. `negative_example` → the
 *   separate failure pool for separate analysis. The two never mix: a
 *   negative or unknown record cannot enter the positive pool, and a
 *   failure-pool record can never be proposed as a procedure.
 * - `ineligible` / `needs_review` / `unknown` → rejected, with the reason
 *   kept as the rejected-candidate proof the issue requires.
 * - Missing source hash or scope → `abstain`, explicitly. Insufficient
 *   data produces an abstention record, never a silent skip and never a
 *   low-confidence admission.
 * - Every record and candidate traces to its sources: source hashes,
 *   scope and revision travel with it. A proposal without traceability
 *   cannot be constructed.
 */

const CODES = Object.freeze({
  REJECTED_INELIGIBLE: 'rejected_ineligible',
  REJECTED_NEEDS_REVIEW: 'rejected_needs_review',
  REJECTED_UNKNOWN: 'rejected_unknown',
  ABSTAIN_INSUFFICIENT_DATA: 'abstain_insufficient_data',
  NOT_IN_POSITIVE_POOL: 'not_in_positive_pool',
  ALREADY_ADMITTED: 'already_admitted',
});

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stableKey(value) {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableKey(value[k])}`).join(',')}}`;
}

/** The traceability every record and candidate must carry. */
function traceOf(input) {
  const sources = Array.isArray(input.sourceHashes) ? input.sourceHashes.filter(nonEmptyString) : [];
  const scope = isRecord(input.scope) ? input.scope : null;
  if (sources.length === 0 || !scope) return null;
  return Object.freeze({
    sources: Object.freeze([...sources]),
    scope: Object.freeze({ ...scope }),
    revision: nonEmptyString(input.revision) || 'unknown',
  });
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Create a learning pool. Pools are caller-held and in-memory; durable
 * procedure storage belongs to the Phase 6 registry, not to admission.
 */
function createLearningPool() {
  const positive = new Map();
  const failures = new Map();
  const rejected = [];

  function admit(input = {}) {
    const trace = traceOf(input);
    if (!trace || !nonEmptyString(input.runId)) {
      return { ok: true, decision: 'abstain', code: CODES.ABSTAIN_INSUFFICIENT_DATA, record: null };
    }
    const key = `${input.runId}|${stableKey(trace.sources)}`;
    if (positive.has(key) || failures.has(key)) {
      return { ok: true, decision: 'duplicate', code: CODES.ALREADY_ADMITTED, record: null };
    }
    const eligibility = input.learningEligibility;
    if (eligibility === 'positive_procedure') {
      const record = Object.freeze({
        runId: input.runId, eligibility, outcomeStatus: input.outcomeStatus || 'unknown',
        trace, admitted: 'positive',
      });
      positive.set(key, record);
      return { ok: true, decision: 'admitted', record };
    }
    if (eligibility === 'negative_example') {
      const record = Object.freeze({
        runId: input.runId, eligibility, outcomeStatus: input.outcomeStatus || 'unknown',
        trace, admitted: 'failure',
      });
      failures.set(key, record);
      return { ok: true, decision: 'admitted', record };
    }
    const code = eligibility === 'needs_review' ? CODES.REJECTED_NEEDS_REVIEW
      : eligibility === 'ineligible' ? CODES.REJECTED_INELIGIBLE
        : CODES.REJECTED_UNKNOWN;
    rejected.push(Object.freeze({ runId: input.runId, eligibility: eligibility || 'unknown', code, trace }));
    return { ok: true, decision: 'rejected', code, record: null };
  }

  /**
   * Propose a procedure candidate from a positive-pool record. Pure data:
   * the pool is unchanged, and no registry, policy or trust surface is
   * touched. Anything not from the positive pool is refused.
   */
  function propose({ runId, sources } = {}) {
    const key = `${runId}|${stableKey(Array.isArray(sources) ? sources : [])}`;
    const record = positive.get(key);
    if (!record) {
      if ([...failures.values()].some((r) => r.runId === runId)) {
        return { ok: false, code: 'failure_not_proposable' };
      }
      return { ok: false, code: CODES.NOT_IN_POSITIVE_POOL };
    }
    return {
      ok: true,
      candidate: Object.freeze({
        status: 'candidate',
        runId: record.runId,
        trace: record.trace,
        outcomeStatus: record.outcomeStatus,
      }),
    };
  }

  function stats() {
    return Object.freeze({
      positive: positive.size, failures: failures.size, rejected: rejected.length,
    });
  }

  function listRejected() {
    return rejected.slice();
  }

  return Object.freeze({ admit, propose, stats, listRejected });
}

module.exports = Object.freeze({ createLearningPool, CODES });

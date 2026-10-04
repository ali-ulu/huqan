'use strict';

/**
 * I1 Cognitive Scheduler (#3311, program #3306).
 *
 * The agent loops already enqueue work and drain it first-in-first-out
 * (`agent.v3.js` shifts the queue; the Dream experiment loop and the follow-up
 * chooser unshift at the front). What they lack is a *decision* about which
 * candidate to run next when more than one is eligible: a goal-relevant,
 * urgency- and risk-aware order with a bounded queue, starvation protection and
 * an explicit stop reason.
 *
 * This module is that decision, and it is deliberately pure. It reads no store,
 * calls no model, and invents no measurement:
 *
 * - **Deterministic.** The score is a fixed linear combination; ties break on
 *   the candidate key. Two calls with the same input return the same order.
 * - **Bounded.** At most `maxDepth` candidates are selected and total `cost`
 *   may never exceed `budget`; exceeding either stops the run with a named
 *   `stopReason` rather than silently dropping or overrunning.
 * - **Starvation-free.** No family may be passed over for more than
 *   `starvationWindow` consecutive picks while it still has an eligible
 *   candidate and budget remains, so a long high-scoring family cannot starve a
 *   short one.
 * - **No overclaim on information gain.** Graph entropy or a rule posterior is
 *   not an epistemic information gain (program #3306). A candidate's
 *   `informationGain` is carried into the trail for the ablation report as
 *   `measured` only when it is a finite number the caller also labels with a
 *   non-empty `informationGainSource`; otherwise it is `unknown`. It never
 *   affects the order, so a forged value cannot buy a better slot.
 *
 * Wiring is opt-in: a caller that does not pass `cognitiveScheduler` keeps the
 * existing FIFO behaviour byte-for-byte. The scheduler only reorders an already
 * eligible set; it does not add candidates, relax the risk ceiling, or widen any
 * authority.
 */

const SCHEDULER_STATUS = Object.freeze({ OK: 'ok', REJECT: 'reject' });

const SCHEDULER_STOP_REASONS = Object.freeze({
  QUEUE_EMPTY: 'queue_empty',
  BUDGET_EXHAUSTED: 'budget_exhausted',
  DEPTH_EXCEEDED: 'depth_exceeded',
});

const SCHEDULER_ERROR_CODES = Object.freeze({
  MISSING_FIELD: 'scheduler_missing_field',
  UNKNOWN_FIELD: 'scheduler_unknown_field',
  INVALID_FIELD: 'scheduler_invalid_field',
  DUPLICATE_KEY: 'scheduler_duplicate_key',
  UNKNOWN_RISK_TIER: 'scheduler_unknown_risk_tier',
});

const RISK_ORDER = Object.freeze({ low: 0, medium: 1, high: 2 });
const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_RISK_TIER = 'medium';
const DEFAULT_STARVATION_WINDOW = 2;
const WEIGHT_RELEVANCE = 0.6;
const WEIGHT_URGENCY = 0.3;
const WEIGHT_RISK = 0.1;

// #3447: the objective the run is serving names the plan step that decides it
// (see `OBJECTIVE_STEPS` in `lib/agent-planning-policy.js`). A goal keyword
// rarely spells that step's tool, so a candidate that is the objective's own
// decision step is relevant even when no goal token matches. It is a *secondary*
// signal: a goal keyword that names a different family still wins, because the
// caller's goal is the stronger statement of intent. Scale, not a second weight,
// keeps the two signals on one axis and the score linear.
const OBJECTIVE_ROLE_FAMILY = Object.freeze({
  learn: 'learn',
  compare: 'compare',
  reason: 'reason',
  verify: 'verify',
  dream: 'dream',
  plan: 'verify',
  investigate: 'verify',
  general: 'verify',
});
const ROLE_RELEVANCE = 0.5;

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

function keywordRelevance(goal, candidate) {
  const goalText = String(goal || '').toLowerCase();
  if (!goalText) return 0;
  // Match on whole tokens, not substrings: "ask" must not match "task".
  const goalTokens = new Set(goalText.split(/[^a-z0-9]+/).filter(Boolean));
  const familyTokens = String(candidate.family || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (!familyTokens.length || !goalTokens.size) return 0;
  return familyTokens.some((token) => goalTokens.has(token)) ? 1 : 0;
}

/**
 * Relevance of one candidate to the run, on the 0..1 axis. A goal keyword that
 * names the candidate's family is the strongest signal (1). Otherwise the
 * objective's decision-step family is a partial match (`ROLE_RELEVANCE`): a goal
 * such as "öğren yeni kural" carries no "learn" token, but the `learn` objective
 * still names `ingest` as the step that decides it. A goal keyword for another
 * family beats the role match, so an explicit caller goal is never overridden.
 */
function relevanceFor(goal, candidate, objective) {
  const keyword = keywordRelevance(goal, candidate);
  if (keyword > 0) return keyword;
  const roleFamily = OBJECTIVE_ROLE_FAMILY[String(objective || '').toLowerCase()];
  if (roleFamily && candidate.family === roleFamily) return ROLE_RELEVANCE;
  return 0;
}

function normalizeCandidate(raw, index) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, code: SCHEDULER_ERROR_CODES.INVALID_FIELD, path: `candidates[${index}]`, message: 'a candidate must be an object' };
  }
  if (typeof raw.key !== 'string' || !raw.key) {
    return { ok: false, code: SCHEDULER_ERROR_CODES.MISSING_FIELD, path: `candidates[${index}].key`, message: 'every candidate requires a non-empty string key' };
  }
  if (typeof raw.family !== 'string' || !raw.family) {
    return { ok: false, code: SCHEDULER_ERROR_CODES.MISSING_FIELD, path: `candidates[${index}].family`, message: 'every candidate requires a non-empty string family' };
  }
  const cost = raw.cost === undefined ? 1 : raw.cost;
  if (!Number.isFinite(cost) || cost < 0) {
    return { ok: false, code: SCHEDULER_ERROR_CODES.INVALID_FIELD, path: `candidates[${index}].cost`, message: 'cost must be a finite number >= 0' };
  }
  const riskTier = raw.riskTier === undefined ? 'low' : raw.riskTier;
  if (!Object.prototype.hasOwnProperty.call(RISK_ORDER, riskTier)) {
    return { ok: false, code: SCHEDULER_ERROR_CODES.UNKNOWN_RISK_TIER, path: `candidates[${index}].riskTier`, message: `unknown risk tier "${riskTier}"` };
  }
  const measured = Number.isFinite(raw.informationGain) && typeof raw.informationGainSource === 'string' && raw.informationGainSource.length > 0;
  return {
    ok: true,
    candidate: {
      key: raw.key,
      family: raw.family,
      relevance: raw.relevance === undefined ? null : clamp01(raw.relevance),
      urgency: raw.urgency === undefined ? null : clamp01(raw.urgency),
      riskTier,
      cost,
      planIndex: Number.isInteger(raw.planIndex) ? raw.planIndex : null,
      informationGain: measured ? raw.informationGain : null,
      informationGainStatus: measured ? 'measured' : 'unknown',
    },
  };
}

function scoreCandidate(candidate, goal, objective = '') {
  const relevance = candidate.relevance === null ? relevanceFor(goal, candidate, objective) : candidate.relevance;
  const urgency = candidate.urgency === null ? 0 : candidate.urgency;
  return round6((WEIGHT_RELEVANCE * relevance) + (WEIGHT_URGENCY * urgency) - (WEIGHT_RISK * RISK_ORDER[candidate.riskTier]));
}

/**
 * Higher score first; on a tie the candidate earlier in the caller's plan wins.
 * The previous key-alphabetical tie-break ignored the plan's own order, so a
 * multi-step plan whose steps scored equally ran in alphabetical step-id order
 * and pushed the step it needed past a bounded budget. Plan order is the
 * scheduler's stated baseline (FIFO), so a tie preserves it.
 */
function compareScored(left, right) {
  if (right.score !== left.score) return right.score - left.score;
  if (left.planIndex !== right.planIndex) return left.planIndex - right.planIndex;
  return left.key.localeCompare(right.key);
}

function scheduleCandidates({ candidates, goal = '', objective = '', budget = Infinity } = {}, opts = {}) {
  if (!Array.isArray(candidates)) {
    return { status: SCHEDULER_STATUS.REJECT, code: SCHEDULER_ERROR_CODES.INVALID_FIELD, message: 'candidates must be an array' };
  }
  const maxDepth = Number.isInteger(opts.maxDepth) && opts.maxDepth > 0 ? opts.maxDepth : DEFAULT_MAX_DEPTH;
  const maxRiskTier = opts.maxRiskTier === undefined ? DEFAULT_MAX_RISK_TIER : opts.maxRiskTier;
  const starvationWindow = Number.isInteger(opts.starvationWindow) && opts.starvationWindow >= 1 ? opts.starvationWindow : DEFAULT_STARVATION_WINDOW;
  if (!Object.prototype.hasOwnProperty.call(RISK_ORDER, maxRiskTier)) {
    return { status: SCHEDULER_STATUS.REJECT, code: SCHEDULER_ERROR_CODES.UNKNOWN_RISK_TIER, message: `unknown maxRiskTier "${maxRiskTier}"` };
  }
  const totalBudget = Number.isFinite(budget) ? budget : Infinity;
  if (totalBudget < 0) {
    return { status: SCHEDULER_STATUS.REJECT, code: SCHEDULER_ERROR_CODES.INVALID_FIELD, message: 'budget must be >= 0 or Infinity' };
  }

  const seen = new Set();
  const eligible = [];
  const trail = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const normalized = normalizeCandidate(candidates[index], index);
    if (!normalized.ok) return { status: SCHEDULER_STATUS.REJECT, ...normalized };
    const candidate = normalized.candidate;
    if (seen.has(candidate.key)) {
      return { status: SCHEDULER_STATUS.REJECT, code: SCHEDULER_ERROR_CODES.DUPLICATE_KEY, message: `duplicate candidate key "${candidate.key}"` };
    }
    seen.add(candidate.key);
    const score = scoreCandidate(candidate, goal, objective);
    const overRisk = RISK_ORDER[candidate.riskTier] > RISK_ORDER[maxRiskTier];
    trail.push({ key: candidate.key, family: candidate.family, score, cost: candidate.cost,
      informationGain: candidate.informationGain, informationGainStatus: candidate.informationGainStatus,
      selected: false, reason: overRisk ? 'above_risk_ceiling' : null });
    if (!overRisk) eligible.push({ ...candidate, score });
  }

  eligible.sort(compareScored);

  const order = [];
  const remaining = [...eligible];
  const lastPickedByFamily = new Map();
  const eligibleFamilies = new Set(eligible.map((candidate) => candidate.family));
  let budgetUsed = 0;
  let stopReason = SCHEDULER_STOP_REASONS.QUEUE_EMPTY;
  let consecutiveFamily = null;
  let consecutiveCount = 0;

  while (remaining.length > 0) {
    if (order.length >= maxDepth) { stopReason = SCHEDULER_STOP_REASONS.DEPTH_EXCEEDED; break; }

    const affordable = remaining.filter((candidate) => budgetUsed + candidate.cost <= totalBudget);
    if (affordable.length === 0) { stopReason = SCHEDULER_STOP_REASONS.BUDGET_EXHAUSTED; break; }

    // Starvation guard: if the last `starvationWindow` picks were all one family
    // and a different family still has an affordable candidate, take that
    // family's best next instead of the global best.
    let choice = affordable[0];
    const starvedFamily = consecutiveCount >= starvationWindow
      ? [...new Set(affordable.map((candidate) => candidate.family))].find((family) => family !== consecutiveFamily)
      : undefined;
    if (starvedFamily !== undefined) {
      choice = affordable.find((candidate) => candidate.family === starvedFamily);
    }

    remaining.splice(remaining.indexOf(choice), 1);
    order.push(choice.key);
    budgetUsed = round6(budgetUsed + choice.cost);
    lastPickedByFamily.set(choice.family, order.length);
    const pickedFamily = choice.family;
    if (pickedFamily === consecutiveFamily) consecutiveCount += 1;
    else { consecutiveFamily = pickedFamily; consecutiveCount = 1; }

    const row = trail.find((entry) => entry.key === choice.key);
    row.selected = true;
    row.reason = starvedFamily !== undefined && choice.family === starvedFamily ? 'starvation_guard' : 'ranked';
  }

  const result = {
    status: SCHEDULER_STATUS.OK,
    order,
    stopReason,
    budgetUsed,
    budgetRemaining: totalBudget === Infinity ? Infinity : round6(totalBudget - budgetUsed),
    selectedCount: order.length,
    eligibleFamilies: [...eligibleFamilies],
    trail,
  };
  return result;
}

module.exports = Object.freeze({
  SCHEDULER_STATUS,
  SCHEDULER_STOP_REASONS,
  SCHEDULER_ERROR_CODES,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_RISK_TIER,
  DEFAULT_STARVATION_WINDOW,
  scoreCandidate,
  scheduleCandidates,
});

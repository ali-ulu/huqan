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
const WEIGHT_URGENCY = 0.3;
const WEIGHT_RISK = 0.1;
// #3447: the objective→step-role signal. It is a within-tier tie-break, not a
// tier of its own: a goal-named step always outranks a non-goal step, so the
// role bonus can only reorder the non-goal steps among themselves.
const WEIGHT_OBJECTIVE_ROLE = 0.2;

/**
 * #3447: the tool the objective relies on, so the scheduler can prefer it when
 * the goal itself names no tool. Mirrors the plan template in
 * `lib/agent-planning-policy.js` (the solution step of each objective).
 */
const OBJECTIVE_ROLE_TOOL = Object.freeze({
  learn: 'learn',
  compare: 'compare',
  reason: 'reason',
  verify: 'verify',
  dream: 'dream',
  plan: 'verify',
  investigate: 'verify',
  general: 'verify',
});

const TIE_BREAK = Object.freeze({ KEY: 'key', INPUT_ORDER: 'input-order' });

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
      index,
      relevance: raw.relevance === undefined ? null : clamp01(raw.relevance),
      urgency: raw.urgency === undefined ? null : clamp01(raw.urgency),
      riskTier,
      cost,
      informationGain: measured ? raw.informationGain : null,
      informationGainStatus: measured ? 'measured' : 'unknown',
    },
  };
}

function relevanceOf(candidate, goal) {
  return candidate.relevance === null ? keywordRelevance(goal, candidate) : candidate.relevance;
}

function scoreCandidate(candidate, goal, objective = '') {
  const relevance = relevanceOf(candidate, goal);
  const urgency = candidate.urgency === null ? 0 : candidate.urgency;
  const roleTool = OBJECTIVE_ROLE_TOOL[objective];
  const role = roleTool !== undefined && candidate.family === roleTool ? 1 : 0;
  const base = (WEIGHT_URGENCY * urgency) + (WEIGHT_OBJECTIVE_ROLE * role) - (WEIGHT_RISK * RISK_ORDER[candidate.riskTier]);
  // A goal-named step (relevance > 0) is a strictly higher tier than any
  // non-goal step, so urgency and the objective-role bonus can only reorder
  // within a tier -- they can never displace a step the goal names.
  return round6((relevance > 0 ? 1 : 0) + base);
}

function compareScored(left, right, tieBreak) {
  if (right.relevant !== left.relevant) return right.relevant - left.relevant;
  if (right.score !== left.score) return right.score - left.score;
  if (tieBreak === TIE_BREAK.INPUT_ORDER) return left.index - right.index;
  return left.key.localeCompare(right.key);
}

function scheduleCandidates({ candidates, goal = '', objective = '', budget = Infinity } = {}, opts = {}) {
  if (!Array.isArray(candidates)) {
    return { status: SCHEDULER_STATUS.REJECT, code: SCHEDULER_ERROR_CODES.INVALID_FIELD, message: 'candidates must be an array' };
  }
  const maxDepth = Number.isInteger(opts.maxDepth) && opts.maxDepth > 0 ? opts.maxDepth : DEFAULT_MAX_DEPTH;
  const maxRiskTier = opts.maxRiskTier === undefined ? DEFAULT_MAX_RISK_TIER : opts.maxRiskTier;
  const starvationWindow = Number.isInteger(opts.starvationWindow) && opts.starvationWindow >= 1 ? opts.starvationWindow : DEFAULT_STARVATION_WINDOW;
  const tieBreak = opts.tieBreak === undefined ? TIE_BREAK.KEY : opts.tieBreak;
  if (!Object.prototype.hasOwnProperty.call(RISK_ORDER, maxRiskTier)) {
    return { status: SCHEDULER_STATUS.REJECT, code: SCHEDULER_ERROR_CODES.UNKNOWN_RISK_TIER, message: `unknown maxRiskTier "${maxRiskTier}"` };
  }
  if (!Object.values(TIE_BREAK).includes(tieBreak)) {
    return { status: SCHEDULER_STATUS.REJECT, code: SCHEDULER_ERROR_CODES.INVALID_FIELD, message: `unknown tieBreak "${tieBreak}"` };
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
    if (!overRisk) eligible.push({ ...candidate, score, relevant: relevanceOf(candidate, goal) > 0 ? 1 : 0 });
  }

  eligible.sort((left, right) => compareScored(left, right, tieBreak));

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
  TIE_BREAK,
  scoreCandidate,
  scheduleCandidates,
});

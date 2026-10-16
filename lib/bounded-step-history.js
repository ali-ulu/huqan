'use strict';

/**
 * Bounded step history for a run (#3618, R53).
 *
 * A run keeps every step report in `state.steps`, and each report carries the
 * full tool result, so a long run grows the array without limit and copies it
 * whole into the durable run record on every step (`_rememberRun` ->
 * `cloneValue(state.steps)`). Two things are wanted from that history and only
 * one of them is bounded: the *count* of steps (drive the step ceiling, the
 * error summary, "the last step", the observability run row) and the *content*
 * of the recent ones (the final report, the last result). The count is already
 * a number; the content is not.
 *
 * This module keeps both without holding every report. It is a ring of the most
 * recent reports plus tallies recorded on the array itself, so:
 *
 * - `pushStepReport` appends and, once the ring is full, drops the oldest;
 * - every dropped report's status and usage are added to running tallies on the
 *   array, so aggregates a reader used to compute by scanning the whole array
 *   (`stepCount`, per-status counts, token/cost totals) stay exact;
 * - `summarizeStepHistory` / `stepHistoryTotals` return the true totals with an
 *   explicit `dropped` count, so a cap never hides that steps happened.
 *
 * The tallies live on the array (`stepHistoryTotals`) rather than in a side map
 * so they survive being copied or cloned with the run record, and stay visible
 * to a reader that only has the array -- including the Observability layer,
 * which must not import Core.
 *
 * The owner of `state.steps` (`lib/agent-step-progression.js#recordStepReport`)
 * writes through `pushStepReport`; every existing reader of the array keeps
 * working because the ring *is* an array -- it is the same object, trimmed in
 * place. Nothing reads it expecting every report back: the step ceiling, the
 * error summary and the "last step" all read `length` or the tail, which the
 * ring preserves.
 */

// The number of recent reports kept in full. Generous enough that the final
// report, the last result and a short review window are always present, and far
// above any default step ceiling (DEFAULT_MAX_STEPS is 4), so a normal run is
// never trimmed at all.
const DEFAULT_MAX_RECENT_STEP_REPORTS = 32;

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function emptyTallies() {
  return {
    count: 0,
    statuses: {},
    usage: { tokens: 0, inputTokens: 0, outputTokens: 0, costMicros: 0 },
    // A field is marked unknown the moment a step that *carried* a usage object
    // left it null, so the run-wide total for that field is null (never a
    // smaller number). A step with no usage object at all is "not measured" and
    // contributes nothing, which is the only reading under which `usageKnown` is
    // meaningful.
    usageUnknown: { tokens: false, inputTokens: false, outputTokens: false, costMicros: false },
    usageKnown: false,
  };
}

// The per-step usage shape the Observability layer sums. Field names and the
// candidate order mirror `lib/observability/helpers.js#extractUsage`, kept in
// step here because Core must not import the Observability layer (the value is
// the layer's own convention, additively extended): a field that is missing on
// every step makes that run-wide total unknown, never a partial zero.
function usageOf(report) {
  const value = report && typeof report === 'object' ? (report.result || report.output || null) : null;
  const candidates = [value, value?.data, value?.usage, value?.data?.usage, value?.meta?.usage];
  const num = (input) => (Number.isFinite(input) ? input : null);
  let tokens = null;
  let inputTokens = null;
  let outputTokens = null;
  let costMicros = null;
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    tokens = tokens === null ? num(candidate.tokens ?? candidate.total_tokens ?? candidate.totalTokens) : tokens;
    inputTokens = inputTokens === null ? num(candidate.input_tokens ?? candidate.inputTokens ?? candidate.prompt_tokens ?? candidate.promptTokens) : inputTokens;
    outputTokens = outputTokens === null ? num(candidate.output_tokens ?? candidate.outputTokens ?? candidate.completion_tokens ?? candidate.completionTokens) : outputTokens;
    costMicros = costMicros === null ? num(candidate.cost_micros ?? candidate.costMicros) : costMicros;
  }
  if (tokens === null && inputTokens !== null && outputTokens !== null) tokens = inputTokens + outputTokens;
  if (tokens === null && inputTokens === null && outputTokens === null && costMicros === null) return null;
  return { tokens, inputTokens, outputTokens, costMicros };
}

function tallyTallies(tallies, report) {
  tallies.count += 1;
  const status = report && typeof report.status === 'string' ? report.status : 'unknown';
  tallies.statuses[status] = (tallies.statuses[status] || 0) + 1;
  const usage = usageOf(report);
  if (!usage) return;
  tallies.usageKnown = true;
  for (const key of ['tokens', 'inputTokens', 'outputTokens', 'costMicros']) {
    // A step that carried a usage object but left this field null marks the
    // run-wide field unknown. A step with no usage object never reaches here:
    // "not measured" is not the same as "measured, and the number is missing".
    if (usage[key] === null) {
      tallies.usageUnknown[key] = true;
      continue;
    }
    if (tallies.usageUnknown[key]) continue;
    tallies.usage[key] = (tallies.usage[key] || 0) + usage[key];
  }
}

function readTallies(steps) {
  const raw = steps && typeof steps === 'object' ? steps.stepHistoryTotals : null;
  if (!raw || typeof raw !== 'object') return emptyTallies();
  const statuses = raw.statuses && typeof raw.statuses === 'object' ? { ...raw.statuses } : {};
  const usage = raw.usage && typeof raw.usage === 'object' ? { ...raw.usage } : emptyTallies().usage;
  const usageUnknown = raw.usageUnknown && typeof raw.usageUnknown === 'object'
    ? { ...emptyTallies().usageUnknown, ...raw.usageUnknown }
    : emptyTallies().usageUnknown;
  return { count: Number(raw.count || 0) || 0, statuses, usage, usageUnknown, usageKnown: raw.usageKnown === true };
}

function materializeUsage(tallies) {
  const usage = { ...tallies.usage };
  for (const key of ['tokens', 'inputTokens', 'outputTokens', 'costMicros']) {
    if (tallies.usageUnknown[key]) usage[key] = null;
  }
  return usage;
}

/**
 * Trim `steps` in place to its most recent `max` entries, moving each dropped
 * report's status and usage into the array's running tallies. Idempotent and
 * safe on a non-array.
 *
 * @param {object[]} steps the run's live step array
 * @param {number} [max] how many recent reports to keep
 * @returns {number} how many entries this call dropped
 */
function boundStepHistory(steps, max = DEFAULT_MAX_RECENT_STEP_REPORTS) {
  if (!Array.isArray(steps)) return 0;
  const cap = positiveInteger(max, DEFAULT_MAX_RECENT_STEP_REPORTS);
  if (steps.length <= cap) return 0;
  const dropped = steps.length - cap;
  const tallies = readTallies(steps);
  for (let index = 0; index < dropped; index += 1) {
    tallyTallies(tallies, steps[index]);
  }
  steps.splice(0, dropped);
  // The tally carrier appears only once something was actually dropped, so a
  // short run's array keeps exactly its reports and nothing else.
  steps.stepHistoryTotals = tallies;
  return dropped;
}

/**
 * Append one step report and keep the history bounded. The one write path for
 * `state.steps`, so the cap can never be bypassed by a second `push`.
 *
 * @param {object[]} steps
 * @param {object} report
 * @param {number} [max]
 * @returns {object} the report, for a caller that wants it back
 */
function pushStepReport(steps, report, max = DEFAULT_MAX_RECENT_STEP_REPORTS) {
  if (!Array.isArray(steps)) return report;
  steps.push(report);
  boundStepHistory(steps, max);
  return report;
}

/**
 * The exact totals for a possibly-bounded step history: the true number of
 * steps ever recorded, the per-status counts, the usage sums, and how many
 * reports the cap dropped. Held reports are scanned live; dropped ones come
 * from the tallies, so the totals never undercount.
 *
 * @param {object[]} steps
 * @returns {{total: number, held: number, dropped: number, statuses: object,
 *   usage: object, usageKnown: boolean, reports: object[]}}
 */
function summarizeStepHistory(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const tallies = readTallies(list);
  // `tallies` already carries the dropped reports; scan the held ones into a
  // working copy so the totals cover the whole run exactly.
  const held = emptyTallies();
  held.count = tallies.count;
  held.statuses = { ...tallies.statuses };
  held.usage = { ...tallies.usage };
  held.usageUnknown = { ...tallies.usageUnknown };
  held.usageKnown = tallies.usageKnown;
  for (const report of list) tallyTallies(held, report);
  return {
    total: held.count,
    held: list.length,
    dropped: tallies.count,
    statuses: held.statuses,
    usage: materializeUsage(held),
    usageUnknown: { ...held.usageUnknown },
    usageKnown: held.usageKnown,
    reports: [...list],
  };
}

/**
 * The true number of steps ever recorded on `steps`, held or dropped. A
 * consumer that used `steps.length` as "how many steps have run" (the step
 * ceiling, `completedSteps`, the termination reason) must read this instead, so
 * the cap cannot make a long run look short.
 *
 * @param {object[]} steps
 * @returns {number}
 */
function stepHistoryCount(steps) {
  if (!Array.isArray(steps)) return 0;
  const tallies = steps.stepHistoryTotals;
  const dropped = tallies && typeof tallies === 'object' ? Number(tallies.count || 0) || 0 : 0;
  return steps.length + dropped;
}

module.exports = {
  DEFAULT_MAX_RECENT_STEP_REPORTS,
  boundStepHistory,
  pushStepReport,
  stepHistoryCount,
  summarizeStepHistory,
};

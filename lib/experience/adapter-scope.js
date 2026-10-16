'use strict';

/**
 * Experience Core — adapter scope declaration and observation coverage
 * (#2388, design #2379).
 *
 * Phase 2 puts every effect surface on the same contract envelope: tool,
 * browser, terminal, filesystem, network, memory, A2A and external outcome.
 * This module is the part that has to exist before any of them can be bound
 * individually — the declaration a run makes about what it had, and the
 * coverage verdict that decides whether the run is admissible for positive
 * learning.
 *
 * ## Why a declaration at all
 *
 * `resolveLearningEligibility` already requires `proofs.coverage` before it
 * will return `positive_procedure`. Nothing produced that proof, so every run
 * was ineligible for positive learning whether or not it was actually covered
 * — a proof that is always false is indistinguishable from a proof that is
 * always missing, and neither tells a reader why.
 *
 * Coverage cannot be inferred after the fact from the events a run happened to
 * emit. A run that touched nothing but `ask` looks identical to a run whose
 * browser adapter silently never reported. The difference is only visible
 * against what the run *said it needed* before it started, which is why the
 * declaration comes first.
 *
 * ## The rules
 *
 * - A required adapter that never observed anything refuses the coverage
 *   proof, and the refusal names the class. It is not an error: the run may
 *   still be recorded, read and verified — it simply cannot be cited as a
 *   positive procedure. That is `#2379`'s "gerekli adapter eksikse positive
 *   learning reddedilir".
 * - An installed or active adapter that never observed anything is `unknown`,
 *   not `unsupported`. Its effect was simply not measured, and an unmeasured
 *   effect must not be read as an absent one.
 * - `unsupported` is a declaration, never an inference: a class the run never
 *   installed and never required is recorded as such. No event is fabricated
 *   for it — inventing one would turn "we did not observe this" into "this did
 *   not happen", which is the failure the whole phase exists to prevent.
 * - Nothing here reads a journal, a store or a clock. It is a pure judgement
 *   over two lists, so it can be tested without a run and cannot disagree with
 *   the events it is judging.
 */

/** The `#2379` taxonomy. Order is the order the design lists them in. */
const ADAPTER_CLASSES = Object.freeze([
  'tool',
  'browser',
  'terminal',
  'filesystem',
  'network',
  'memory',
  'a2a',
  'external_outcome',
]);

const KNOWN_CLASSES = Object.freeze(new Set(ADAPTER_CLASSES));

/** Per-class observation verdict. `unknown` is a result, not an absence. */
const COVERAGE_VERDICTS = Object.freeze({
  COVERED: 'covered',
  UNKNOWN: 'unknown',
  UNSUPPORTED: 'unsupported',
});

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/** A list of class ids, each known and unique. `undefined` reads as empty. */
function normalizeClassList(value, field) {
  if (value === undefined || value === null) return { ok: true, list: [] };
  if (!Array.isArray(value)) return { ok: false, code: `invalid_${field}` };
  const seen = new Set();
  for (const id of value) {
    if (!isNonEmptyString(id) || !KNOWN_CLASSES.has(id)) {
      return { ok: false, code: `unknown_adapter_class:${String(id)}` };
    }
    if (seen.has(id)) return { ok: false, code: `duplicate_adapter_class:${id}` };
    seen.add(id);
  }
  return { ok: true, list: [...seen] };
}

/**
 * Declare what a run had before it starts.
 *
 * `input` is `{ installed, active, required }`, each a list of class ids. The
 * three are independent on purpose: `active` without `installed` is a
 * declaration error, and `required` without `installed` is the exact case this
 * module exists to make visible — it is recorded, not refused, so the run can
 * proceed and the coverage verdict can refuse positive learning later.
 *
 * Returns `{ ok: true, scope }` or `{ ok: false, code }` for a malformed
 * declaration.
 */
function declareAdapterScope(input = {}) {
  const installed = normalizeClassList(input.installed, 'installed');
  if (!installed.ok) return installed;
  const active = normalizeClassList(input.active, 'active');
  if (!active.ok) return active;
  const required = normalizeClassList(input.required, 'required');
  if (!required.ok) return required;

  const installedSet = new Set(installed.list);
  for (const id of active.list) {
    if (!installedSet.has(id)) return { ok: false, code: `active_not_installed:${id}` };
  }
  for (const id of required.list) {
    if (!installedSet.has(id)) return { ok: false, code: `required_not_installed:${id}` };
  }

  return {
    ok: true,
    scope: Object.freeze({
      installed: Object.freeze(installed.list),
      active: Object.freeze(active.list),
      required: Object.freeze(required.list),
    }),
  };
}

/** The verdict for one class, given what the run actually observed. */
function verdictForClass(scope, observedSet, id) {
  if (observedSet.has(id)) return COVERAGE_VERDICTS.COVERED;
  // Not observed: what it means depends on what the run said it had. A
  // required class that stayed silent is a gap; an installed one is an
  // unmeasured effect; one the run never had is simply unsupported.
  if (scope.required.includes(id)) return COVERAGE_VERDICTS.UNKNOWN;
  if (scope.installed.includes(id)) return COVERAGE_VERDICTS.UNKNOWN;
  return COVERAGE_VERDICTS.UNSUPPORTED;
}

/**
 * Judge the run's observation coverage.
 *
 * `observed` is the list of class ids that produced at least one correlated
 * event during the run. Returns a frozen report:
 *
 * - `perClass` — one verdict per class in the taxonomy, so a reader sees the
 *   `unsupported` classes rather than inferring them from silence.
 * - `missingRequired` — required classes that observed nothing, named.
 * - `unknown` — installed/active classes that observed nothing, named.
 * - `coverage` — the `proofs.coverage` value. True only when every required
 *   class was covered.
 *
 * The report is deliberately not a boolean. `coverage: false` with an empty
 * `missingRequired` means the declaration was empty, which is a different fact
 * from a named gap, and the two must not collapse into one answer.
 */
function resolveObservationCoverage(scope, observed = []) {
  const empty = { installed: [], active: [], required: [] };
  const declared = scope && typeof scope === 'object' ? scope : empty;
  const observedList = normalizeClassList(observed, 'observed');
  const observedSet = new Set(observedList.ok ? observedList.list : []);

  const perClass = {};
  const missingRequired = [];
  const unknown = [];
  for (const id of ADAPTER_CLASSES) {
    const verdict = verdictForClass(declared, observedSet, id);
    perClass[id] = verdict;
    if (verdict !== COVERAGE_VERDICTS.COVERED) {
      if (declared.required && declared.required.includes(id)) missingRequired.push(id);
      else if (verdict === COVERAGE_VERDICTS.UNKNOWN) unknown.push(id);
    }
  }

  const required = Array.isArray(declared.required) ? declared.required : [];
  return Object.freeze({
    perClass: Object.freeze(perClass),
    missingRequired: Object.freeze(missingRequired),
    unknown: Object.freeze(unknown),
    coverage: required.length > 0 && missingRequired.length === 0,
  });
}

/**
 * The coverage proof, in the shape `resolveLearningEligibility` consumes.
 *
 * Kept separate from the report so a caller that already has a full proof set
 * can merge one key rather than rebuild the object, and so the reason a proof
 * is false stays readable at the call site instead of being re-derived.
 */
function coverageProof(scope, observed = []) {
  const report = resolveObservationCoverage(scope, observed);
  return Object.freeze({ coverage: report.coverage, report });
}

module.exports = {
  ADAPTER_CLASSES,
  COVERAGE_VERDICTS,
  declareAdapterScope,
  resolveObservationCoverage,
  coverageProof,
};

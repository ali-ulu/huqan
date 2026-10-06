'use strict';

/**
 * Inference — scoped defeasible intake (#3497, R42).
 *
 * The proof side and the learning side of inference were produced on the same
 * path and read as if they were the same thing: a `not_proven` result could be
 * consumed as a refuted rule, and a defeater carried no record of *what it was
 * a defeater over*. This module is the seam that keeps the two apart and makes
 * the scope explicit. It is a pure projection — it produces a record and never
 * writes intake, a registry or a store.
 *
 * ## Proof production is not learning intake
 *
 * `proveFromRules` (./inference-runtime.js) returns a status and a proof trace.
 * That is *production*: what the prover did over a given rule set. Whether it
 * is *evidence* for a rule's belief is a separate judgement, made in scope.
 * The record below carries both sides in different fields (`proof` vs `intake`)
 * and never folds one into the other. `registered` is `false` on every result:
 * feeding intake stays a separate, gated act.
 *
 * ## Negation-as-failure is bounded by `?SCOPE`
 *
 * "Not proven" is not "false". A prover that fails to derive a fact has shown
 * an absence *in the scope it was given*, not in the world. Reading that as a
 * refutation is the closed-world assumption, and it is only sound when the
 * scope declares itself complete. `deriveScopedIntake` therefore maps
 *
 * - `proven`                      -> positive evidence, always;
 * - `not_proven` + closed scope   -> negative evidence, scoped to that scope;
 * - `not_proven` + open scope     -> *no* evidence (`open_world_absence`);
 * - `unknown` / `stopped` / `invalid` -> *no* evidence, never false.
 *
 * The `?SCOPE` a defeater is issued over is part of the record, so a defeater
 * from one scope can never be read as a defeater in another.
 *
 * ## Semantic dominance is not physical deletion
 *
 * When a stronger claim dominates a weaker one, the weaker record is *marked*
 * superseded with a `dominatedBy` link and its provenance intact. It is never
 * erased: the history that produced it stays checkable, and a reader can tell
 * "weaker, superseded by X" from "never existed". `applySemanticDominance`
 * returns `deleted: false` on every result — physical removal is out of scope.
 */

const SCHEMA_VERSION = 'huqan.defeasible-scope.v1';

/** The prover's own vocabulary, restated so a reader needs no other import. */
const PROOF_CLASS = Object.freeze({
  PROVEN: 'proven',
  NOT_PROVEN: 'not_proven',
  UNKNOWN: 'unknown',
  STOPPED: 'stopped',
  INVALID: 'invalid',
});

const KNOWN_PROOF_CLASSES = Object.freeze(new Set(Object.values(PROOF_CLASS)));

/** The learning-relevant signal a scoped proof yields. */
const INTAKE_SIGNAL = Object.freeze({
  POSITIVE: 'positive',
  NEGATIVE: 'negative',
  NONE: 'none',
});

/** Why a scope did or did not produce evidence. Stable strings, not prose. */
const INTAKE_REASON = Object.freeze({
  PROVEN_IN_SCOPE: 'proven_in_scope',
  CLOSED_WORLD_ABSENCE: 'closed_world_absence',
  OPEN_WORLD_ABSENCE: 'open_world_absence',
  PROOF_UNKNOWN: 'proof_unknown',
  PROOF_STOPPED: 'proof_stopped',
  PROOF_INVALID: 'proof_invalid',
});

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function sortedUniqueStrings(values, label) {
  if (values === undefined || values === null) return Object.freeze([]);
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  return Object.freeze([...new Set(values.map((value) => nonEmptyString(value, label)))].sort());
}

/**
 * Normalize a `?SCOPE` descriptor. `closedWorld` defaults to `false`: a scope
 * must *say* it is complete before an absence in it counts as a refutation, so
 * silence means open, never closed.
 */
function normalizeScope(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('scope must be an object');
  }
  const scopeId = nonEmptyString(input.scopeId, 'scope.scopeId');
  const closedWorld = input.closedWorld === undefined ? false : input.closedWorld;
  if (typeof closedWorld !== 'boolean') throw new TypeError('scope.closedWorld must be a boolean');
  const workspaceId = input.workspaceId === undefined || input.workspaceId === null
    ? null
    : nonEmptyString(input.workspaceId, 'scope.workspaceId');
  return Object.freeze({
    scopeId,
    workspaceId,
    ruleIds: sortedUniqueStrings(input.ruleIds, 'scope.ruleIds'),
    factRefs: sortedUniqueStrings(input.factRefs, 'scope.factRefs'),
    closedWorld,
  });
}

/** Map a prover status to a proof class. An unrecognised status is `invalid`. */
function classifyProof(status) {
  const text = nonEmptyString(status, 'proof status');
  return KNOWN_PROOF_CLASSES.has(text) ? text : PROOF_CLASS.INVALID;
}

/**
 * Render a query/claim into a stable, human-readable reference (e.g.
 * `edge(a, c)`), so a record — and a defeater — says *what* it is about. This
 * is what keeps two `not_proven` results that share a scope and reason
 * distinguishable. Accepts an atom `{ predicate, args }` from the rule IR, a
 * bare string, or `null`.
 */
function describeClaim(claim) {
  if (claim === undefined || claim === null) return null;
  if (typeof claim === 'string') return nonEmptyString(claim, 'claim');
  if (typeof claim !== 'object' || Array.isArray(claim)) throw new TypeError('claim must be an atom, a string or null');
  const predicate = nonEmptyString(claim.predicate, 'claim.predicate');
  const args = Array.isArray(claim.args) ? claim.args : [];
  const terms = args.map((arg) => {
    if (arg === undefined || arg === null) return '_';
    if (typeof arg === 'string' || typeof arg === 'number' || typeof arg === 'boolean') return String(arg);
    if (arg.kind === 'variable') return arg.name;
    if (arg.kind === 'constant') return arg.value;
    return '_';
  });
  return terms.length > 0 ? `${predicate}(${terms.join(', ')})` : predicate;
}

/** Walk a frozen proof trace and collect the rule ids it used, plus its depth. */
function proofTraceRefs(proof) {
  const ruleIds = new Set();
  let depth = 0;
  const visit = (node, level) => {
    if (!node || typeof node !== 'object') return;
    if (level > depth) depth = level;
    if (typeof node.ruleId === 'string' && node.ruleId.trim() !== '') ruleIds.add(node.ruleId.trim());
    if (Array.isArray(node.premises)) for (const premise of node.premises) visit(premise, level + 1);
  };
  visit(proof, 0);
  return Object.freeze({ ruleIds: Object.freeze([...ruleIds].sort()), depth });
}

/**
 * Project a scoped proof result into a separated, provenance-preserving record.
 *
 * `status` and `reason` come from the prover (`proveFromRules`); `proof` is its
 * trace (optional); `scope` is the `?SCOPE` the proof was run over and is
 * required; `claim` is the query the proof answered (optional). The result never
 * carries a bare boolean "defeated": a defeater is present only when the scope
 * is closed and the fact was not proven, and it is always tagged with the scope
 * it belongs to *and* the claim it is over, so two absences stay distinguishable.
 */
function deriveScopedIntake(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('input must be an object');
  }
  const scope = normalizeScope(input.scope);
  const proofClass = classifyProof(input.status);
  const reason = input.reason === undefined || input.reason === null
    ? null
    : nonEmptyString(input.reason, 'reason');
  const claim = describeClaim(input.claim);
  const trace = proofTraceRefs(input.proof);

  let signal = INTAKE_SIGNAL.NONE;
  let intakeReason;
  let defeater = null;

  if (proofClass === PROOF_CLASS.PROVEN) {
    signal = INTAKE_SIGNAL.POSITIVE;
    intakeReason = INTAKE_REASON.PROVEN_IN_SCOPE;
  } else if (proofClass === PROOF_CLASS.NOT_PROVEN && scope.closedWorld === true) {
    signal = INTAKE_SIGNAL.NEGATIVE;
    intakeReason = INTAKE_REASON.CLOSED_WORLD_ABSENCE;
    defeater = Object.freeze({
      scoped: true,
      scopeId: scope.scopeId,
      claim,
      kind: 'negation_as_failure',
      reason: reason || 'no_proof',
    });
  } else if (proofClass === PROOF_CLASS.NOT_PROVEN) {
    // Open scope: the absence is real but says nothing about the world.
    intakeReason = INTAKE_REASON.OPEN_WORLD_ABSENCE;
  } else if (proofClass === PROOF_CLASS.UNKNOWN) {
    intakeReason = INTAKE_REASON.PROOF_UNKNOWN;
  } else if (proofClass === PROOF_CLASS.STOPPED) {
    intakeReason = INTAKE_REASON.PROOF_STOPPED;
  } else {
    intakeReason = INTAKE_REASON.PROOF_INVALID;
  }

  const provenance = Object.freeze({
    scopeId: scope.scopeId,
    ruleIds: Object.freeze([...new Set([...scope.ruleIds, ...trace.ruleIds])].sort()),
    proofDepth: trace.depth,
    proofRef: typeof input.proofRef === 'string' && input.proofRef.trim() !== ''
      ? input.proofRef.trim()
      : null,
  });

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    // Production side: what the prover did. Kept separate from the signal.
    proof: Object.freeze({ class: proofClass, status: String(input.status).trim(), reason }),
    // What the proof was about, so a record is never an anonymous absence.
    claim,
    // Learning side: whether that is evidence, and why.
    intake: Object.freeze({ signal, reason: intakeReason }),
    scope,
    defeater,
    provenance,
    // Stated, not omitted: this projection never feeds intake and never erases.
    registered: false,
    deleted: false,
  });
}

/**
 * Mark `existing` superseded by `dominator` without deleting it. The weaker
 * record keeps its provenance and gains a `dominatedBy` link plus the reason,
 * so "weaker, superseded" stays distinguishable from "never existed". Physical
 * removal is refused: the result always reports `deleted: false`.
 */
function applySemanticDominance({ existing, dominator, at, reason } = {}) {
  const existingId = nonEmptyString(existing && (existing.recordId || existing.id), 'existing.recordId');
  const dominatorId = nonEmptyString(dominator && (dominator.recordId || dominator.id), 'dominator.recordId');
  if (existingId === dominatorId) {
    throw new TypeError('a record cannot dominate itself');
  }
  const atText = at === undefined || at === null ? null : nonEmptyString(at, 'at');
  const reasonText = reason === undefined || reason === null
    ? 'semantic_dominance'
    : nonEmptyString(reason, 'reason');
  const record = Object.freeze({
    ...existing,
    recordId: existingId,
    state: 'superseded',
    dominatedBy: dominatorId,
    dominatedAt: atText,
    dominanceReason: reasonText,
  });
  return Object.freeze({
    action: 'marked_superseded',
    deleted: false,
    record,
  });
}

module.exports = Object.freeze({
  SCHEMA_VERSION,
  PROOF_CLASS,
  INTAKE_SIGNAL,
  INTAKE_REASON,
  normalizeScope,
  classifyProof,
  describeClaim,
  deriveScopedIntake,
  applySemanticDominance,
});

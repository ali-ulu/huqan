'use strict';

/**
 * Experience Phase 6 — Procedure Registry (#2393, design #2382 comment).
 *
 * Durable(-shaped) storage for what `compiler.js`'s `compile()` produces in
 * memory today. Every phase since #2394 has carried the same caveat —
 * `boundProcedureVersion` is "an opaque, caller-supplied string... nothing
 * interprets it beyond equality" — because this registry did not exist.
 * This module retires that caveat: it is what `boundProcedureVersion`
 * should eventually resolve against. Wiring that resolution into
 * `capability-trust.js` is explicitly NOT this module's job (see #2382's
 * design comment) — this file is a new, separate module, not an extension
 * of `capability-trust.js`.
 *
 * Pure functional core plus a small in-memory registry, following the same
 * shape as `createLearningPool()` (./learning.js) and
 * `createCapabilityTrustRegistry()` (./capability-trust.js): caller-held,
 * in-memory, no storage backend invented here. Restart-durability is out of
 * scope for this delivery — a caller that needs cross-process durability
 * wires its own persistence around these pure functions.
 *
 * ## What gets stored
 *
 * `register()` stores exactly the fields `compiler.js`'s `compile()`
 * produces — `kind, version, hash, parentHash, params, preconditions,
 * postconditions, evidenceRefs, scope, revision` — copied verbatim, never
 * re-derived. Keyed by `(workspaceId, kind, version)`.
 *
 * ## Immutability
 *
 * The same `(workspaceId, kind, version)` triple can never be registered
 * with different content: a second `register()` call with the same key and
 * a different hash is refused with a tamper-shaped code, not overwritten.
 * The identical `(key, hash)` pair registered twice (a retried caller) is
 * idempotent — the same success result, not a duplicate entry. An old
 * version remains independently fetchable by its own version number
 * forever; registering a newer version never deletes or mutates it.
 *
 * ## Active version is a pointer, not a deletion
 *
 * `setActiveVersion()` changes which version a `(workspaceId, kind)` points
 * at; it never removes or mutates the entry it points away from.
 * `register()` itself does not move the pointer — activation is a
 * deliberate, separate act, so "registered" and "active" cannot be
 * conflated by a caller reading only `get()`. (Resolved ambiguity: the
 * design comment does not say whether registering a kind's first version
 * auto-activates it; refusing to guess here means `getActiveVersion()`
 * reports `no_active_version` — an explicit gap, not a silent default —
 * until a caller calls `setActiveVersion()`.)
 *
 * ## Activation requires qualification evidence (#3460)
 *
 * A registered version is not activatable on its own. `setActiveVersion()`
 * refuses with `qualification_missing` unless a passing `qualify()` result
 * bound to that exact `(workspaceId, kind, version)` and the entry's own
 * `hash` has been recorded through `recordQualification()`. Evidence is
 * bound to the immutable hash, so a pass for a different version or hash
 * cannot authorize this one, and a candidate can never authorize its own
 * activation: the qualification act and the activation act stay separate,
 * and activation without evidence fails closed rather than defaulting
 * through. `recordQualification()` still accumulates the kind-level history
 * the coverage gate reads; a `version` argument additionally binds the
 * outcome to that version.
 *
 * Every successful pointer move is recorded as a rollback entry
 * (`fromVersion`/`toVersion`/`at`), readable via `getRollbackHistory()`;
 * `rollbackActiveVersion()` moves the pointer back to the version that was
 * active before the last move and records the reverse transition, so a
 * promotion can always be undone and the undo is itself auditable.
 *
 * ## Provenance stamp and override event (#3465)
 *
 * `register()` requires a `provenance` stamp — `sourceSha`,
 * `procedureVersion` and `configHash`, all non-empty strings — so the same
 * procedure measured under a different source or config stays
 * distinguishable. A missing field refuses with `provenance_missing` and
 * names the absent fields; nothing is stored. The stamp is part of the
 * immutable entry, but identity stays `(key, hash)`: re-registering the same
 * pair with a different stamp is idempotent and keeps the original stamp.
 *
 * `overrideActiveVersion()` is the only way to move the pointer without
 * qualification evidence. It needs a non-empty `actor` and `reason`, records
 * a `kind: 'override'` entry in the same append-only history, never writes
 * qualification evidence, and stays undoable through
 * `rollbackActiveVersion()`. Normal moves are recorded as `kind: 'activate'`
 * and undo moves as `kind: 'rollback'`.
 *
 * ## Workspace isolation
 *
 * Every entry key includes `workspaceId`; `get()` for one workspace can
 * never return another workspace's entry. Matching #2394/#2396's hard-assert
 * discipline, a malformed or empty `workspaceId` is refused by throwing
 * (not silently narrowed to some default namespace that could then be
 * shared across callers) — an empty or non-string workspace identity is
 * exactly the kind of call that would let one workspace's registration
 * bleed into another's key space.
 *
 * ## Coverage gate
 *
 * `evaluateCoverageGate()` implements the design comment's concrete
 * formula: a `kind`'s recorded qualification history in a workspace must
 * show BOTH the `drift` and `ambiguous` rejection paths
 * (`qualify_rejected:drift`, `qualify_rejected:ambiguous`) having fired at
 * least once, ever, on ANY candidate of that kind in that workspace — not
 * necessarily the one being evaluated now. A brand-new kind with zero
 * rejection-path history fails this gate and cannot admit its first
 * procedure — intentional, matching #2394's own `insufficient-data` bias:
 * absence of evidence that the checks work is not evidence they are
 * unnecessary.
 */

const REJECTION_CODES = Object.freeze({
  DRIFT: 'qualify_rejected:drift',
  AMBIGUOUS: 'qualify_rejected:ambiguous',
});

const CODES = Object.freeze({
  INVALID_WORKSPACE: 'invalid_workspace',
  INVALID_PROCEDURE: 'invalid_procedure',
  TAMPER_DETECTED: 'tamper_detected',
  NOT_FOUND: 'not_found',
  NO_ACTIVE_VERSION: 'no_active_version',
  COVERAGE_INSUFFICIENT: 'coverage_insufficient',
  QUALIFICATION_MISSING: 'qualification_missing',
  NO_ROLLBACK_TARGET: 'no_rollback_target',
  PROVENANCE_MISSING: 'provenance_missing',
  OVERRIDE_REASON_MISSING: 'override_reason_missing',
});

const PROVENANCE_FIELDS = Object.freeze(['sourceSha', 'procedureVersion', 'configHash']);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Hard-assert on a malformed workspace identity. Every public function that
 * touches a workspace's key space calls this first — throwing here is what
 * keeps an empty or non-string `workspaceId` from ever being treated as a
 * shared or default namespace that other workspaces could collide into.
 */
function assertWorkspaceId(workspaceId) {
  if (!nonEmptyString(workspaceId)) {
    throw new TypeError('procedure-registry: workspaceId must be a non-empty string');
  }
}

function assertKind(kind) {
  if (!nonEmptyString(kind)) {
    throw new TypeError('procedure-registry: kind must be a non-empty string');
  }
}

function entryKey(workspaceId, kind, version) {
  return JSON.stringify([workspaceId, kind, version]);
}

function activeKey(workspaceId, kind) {
  return JSON.stringify([workspaceId, kind]);
}

function validProcedureShape(procedure) {
  return isRecord(procedure)
    && nonEmptyString(procedure.kind)
    && Number.isInteger(procedure.version) && procedure.version > 0
    && nonEmptyString(procedure.hash);
}

function missingProvenance(provenance) {
  if (!isRecord(provenance)) return [...PROVENANCE_FIELDS];
  return PROVENANCE_FIELDS.filter((field) => !nonEmptyString(provenance[field]));
}

function toStoredEntry(workspaceId, procedure, provenance, registeredAt) {
  return Object.freeze({
    workspaceId,
    kind: procedure.kind,
    version: procedure.version,
    hash: procedure.hash,
    parentHash: procedure.parentHash === undefined ? null : procedure.parentHash,
    params: procedure.params,
    preconditions: procedure.preconditions,
    postconditions: procedure.postconditions,
    evidenceRefs: procedure.evidenceRefs,
    scope: procedure.scope,
    revision: procedure.revision,
    provenance: Object.freeze(Object.fromEntries(PROVENANCE_FIELDS.map((field) => [field, provenance[field]]))),
    registeredAt,
  });
}

/**
 * Create a procedure registry. In-memory and caller-held, matching
 * ./learning.js and ./capability-trust.js: no storage backend is invented
 * here.
 */
function createProcedureRegistry() {
  /** @type {Map<string, object>} */
  const entries = new Map();
  /** @type {Map<string, number>} */
  const active = new Map();
  /** @type {Map<string, object[]>} */
  const qualificationHistory = new Map();
  /** @type {Map<string, Map<string, object>>} version-bound passing evidence */
  const activationEvidence = new Map();
  /** @type {Map<string, number[]>} prior versions still rollback-able */
  const rollbackTargets = new Map();
  /** @type {Map<string, object[]>} append-only audit of every move */
  const rollbackHistory = new Map();

  /**
   * Register a compiled procedure (`compiler.js`'s `compile()` output)
   * under `(workspaceId, kind, version)`. Idempotent for an identical
   * `(key, hash)` pair; refused with a tamper-shaped code for the same key
   * with a different hash.
   */
  function register({ workspaceId, procedure, provenance } = {}) {
    assertWorkspaceId(workspaceId);
    if (!validProcedureShape(procedure)) {
      return { ok: false, code: CODES.INVALID_PROCEDURE };
    }
    const missing = missingProvenance(provenance);
    if (missing.length > 0) {
      return { ok: false, code: CODES.PROVENANCE_MISSING, missing };
    }
    const key = entryKey(workspaceId, procedure.kind, procedure.version);
    const existing = entries.get(key);
    if (existing) {
      if (existing.hash === procedure.hash) {
        return { ok: true, idempotent: true, entry: existing };
      }
      return { ok: false, code: CODES.TAMPER_DETECTED };
    }
    const stored = toStoredEntry(workspaceId, procedure, provenance, Date.now());
    entries.set(key, stored);
    return { ok: true, idempotent: false, entry: stored };
  }

  /** Workspace-scoped, version-exact read. Never returns another entry. */
  function get({ workspaceId, kind, version } = {}) {
    assertWorkspaceId(workspaceId);
    assertKind(kind);
    const entry = entries.get(entryKey(workspaceId, kind, version));
    if (!entry) return { ok: false, code: CODES.NOT_FOUND };
    return { ok: true, entry };
  }

  /**
   * Point `(workspaceId, kind)`'s active version at an already-registered
   * version. Never deletes or mutates the entry the pointer moves away
   * from — every prior version stays independently fetchable via `get()`.
   *
   * Fails closed without version-bound qualification evidence (#3460): the
   * pointer moves only when a passing `qualify()` result for this exact
   * `(workspaceId, kind, version)` and the entry's own `hash` was recorded.
   */
  function setActiveVersion({ workspaceId, kind, version } = {}) {
    assertWorkspaceId(workspaceId);
    assertKind(kind);
    const entry = entries.get(entryKey(workspaceId, kind, version));
    if (!entry) {
      return { ok: false, code: CODES.NOT_FOUND };
    }
    const evidence = activationEvidence.get(activeKey(workspaceId, kind));
    const proven = evidence && evidence.get(String(version));
    if (!proven || proven.hash !== entry.hash) {
      return { ok: false, code: CODES.QUALIFICATION_MISSING };
    }
    const key = activeKey(workspaceId, kind);
    const fromVersion = active.get(key);
    // Activating the already-active version is an idempotent no-op: recording
    // a `v2 -> v2` move would make a later rollback select it and leave the
    // pointer unchanged instead of restoring the real prior version.
    if (fromVersion === version) {
      return { ok: true, activeVersion: version, idempotent: true };
    }
    const record = moveActive(key, version, 'activate');
    return { ok: true, activeVersion: version, rollback: record };
  }

  /**
   * Move the pointer and append the audit record. Rollback targets track only
   * promotions that have not been undone; the history stays append-only and
   * keeps the reverse moves too.
   */
  function moveActive(key, version, kind, extra = {}) {
    const fromVersion = active.get(key);
    active.set(key, version);
    const record = Object.freeze({ kind, at: Date.now(), fromVersion: fromVersion ?? null, toVersion: version, ...extra });
    const history = rollbackHistory.get(key) || [];
    history.push(record);
    rollbackHistory.set(key, history);
    if (fromVersion !== undefined) {
      const targets = rollbackTargets.get(key) || [];
      targets.push(fromVersion);
      rollbackTargets.set(key, targets);
    }
    return record;
  }

  /**
   * Explicit, audited pointer move that bypasses qualification evidence. It
   * records a `kind: 'override'` event carrying `actor` and `reason`, writes
   * no qualification evidence, and can be undone by `rollbackActiveVersion()`.
   */
  function overrideActiveVersion({ workspaceId, kind, version, actor, reason } = {}) {
    assertWorkspaceId(workspaceId);
    assertKind(kind);
    if (!nonEmptyString(actor) || !nonEmptyString(reason)) {
      return { ok: false, code: CODES.OVERRIDE_REASON_MISSING };
    }
    if (!entries.get(entryKey(workspaceId, kind, version))) {
      return { ok: false, code: CODES.NOT_FOUND };
    }
    const key = activeKey(workspaceId, kind);
    if (active.get(key) === version) {
      return { ok: true, activeVersion: version, idempotent: true };
    }
    const record = moveActive(key, version, 'override', { actor, reason });
    return { ok: true, activeVersion: version, rollback: record };
  }

  /**
   * Undo the most recent not-yet-undone activation, moving the pointer back to
   * the version active before it. The reverse move is recorded in the audit
   * history too, so the undo is auditable. Refuses with `no_rollback_target`
   * when there is no promotion left to undo.
   */
  function rollbackActiveVersion({ workspaceId, kind } = {}) {
    assertWorkspaceId(workspaceId);
    assertKind(kind);
    const key = activeKey(workspaceId, kind);
    const targets = rollbackTargets.get(key) || [];
    const fromVersion = targets.pop();
    if (fromVersion === undefined) {
      return { ok: false, code: CODES.NO_ROLLBACK_TARGET };
    }
    const previous = active.get(key);
    active.set(key, fromVersion);
    const record = Object.freeze({ kind: 'rollback', at: Date.now(), fromVersion: previous, toVersion: fromVersion });
    const history = rollbackHistory.get(key) || [];
    history.push(record);
    rollbackHistory.set(key, history);
    return { ok: true, activeVersion: fromVersion, rollback: record };
  }

  /** Ordered, immutable rollback entries for a `(workspaceId, kind)`. */
  function getRollbackHistory({ workspaceId, kind } = {}) {
    assertWorkspaceId(workspaceId);
    assertKind(kind);
    return { ok: true, entries: Object.freeze([...(rollbackHistory.get(activeKey(workspaceId, kind)) || [])]) };
  }

  /** Read the current active-version pointer, or `no_active_version`. */
  function getActiveVersion({ workspaceId, kind } = {}) {
    assertWorkspaceId(workspaceId);
    assertKind(kind);
    const version = active.get(activeKey(workspaceId, kind));
    if (version === undefined) return { ok: false, code: CODES.NO_ACTIVE_VERSION };
    return { ok: true, version };
  }

  /**
   * Accumulate one `qualify()` call's outcome against `(workspaceId,
   * kind)`'s history. `details` is stored exactly as given — this module
   * does not reinterpret `compiler.js`'s `qualify()` output, only reads its
   * `code` field later when evaluating the coverage gate.
   *
   * When `version` is given the outcome is additionally bound to that
   * version's immutable hash (`entry.hash`, never a caller-supplied hash), so
   * a passing result authorizes activation of exactly that version and no
   * other. A pass for a version that is not registered is ignored for
   * activation — there is no entry to bind it to.
   */
  function recordQualification({
    workspaceId, kind, version, at = Date.now(), details, coverageContribution = null,
  } = {}) {
    assertWorkspaceId(workspaceId);
    assertKind(kind);
    if (!isRecord(details)) {
      return { ok: false, code: CODES.INVALID_PROCEDURE };
    }
    const key = activeKey(workspaceId, kind);
    const history = qualificationHistory.get(key) || [];
    const record = Object.freeze({ at, details, coverageContribution });
    history.push(record);
    qualificationHistory.set(key, history);
    if (version !== undefined) {
      const entry = entries.get(entryKey(workspaceId, kind, version));
      // Evidence must describe THIS version: a caller could pair a passing
      // result whose `procedureHash` names another version with `version:
      // <this>` and authorize a version `qualify()` never passed for. The
      // version's own immutable hash is the arbiter, so a mismatch stores
      // nothing (fail-closed, not a weaker check).
      if (entry && details.ok === true && details.procedureHash === entry.hash) {
        const evidence = activationEvidence.get(key) || new Map();
        evidence.set(String(version), Object.freeze({ at, hash: entry.hash }));
        activationEvidence.set(key, evidence);
      }
    }
    return { ok: true, record };
  }

  /**
   * Per-`(workspaceId, kind)` coverage gate: admissible only once both the
   * `drift` and `ambiguous` named rejection paths have fired at least once,
   * ever, in this workspace, on any candidate of this kind.
   */
  function evaluateCoverageGate({ workspaceId, kind } = {}) {
    assertWorkspaceId(workspaceId);
    assertKind(kind);
    const history = qualificationHistory.get(activeKey(workspaceId, kind)) || [];
    const codesSeen = new Set(
      history.map((r) => (isRecord(r.details) ? r.details.code : undefined)).filter(Boolean),
    );
    const missing = [REJECTION_CODES.DRIFT, REJECTION_CODES.AMBIGUOUS]
      .filter((code) => !codesSeen.has(code));
    if (missing.length > 0) {
      return { ok: true, admissible: false, code: CODES.COVERAGE_INSUFFICIENT, missing };
    }
    return { ok: true, admissible: true, missing: [] };
  }

  return Object.freeze({
    register,
    get,
    setActiveVersion,
    overrideActiveVersion,
    rollbackActiveVersion,
    getRollbackHistory,
    getActiveVersion,
    recordQualification,
    evaluateCoverageGate,
  });
}

module.exports = Object.freeze({
  createProcedureRegistry,
  CODES,
  REJECTION_CODES,
});

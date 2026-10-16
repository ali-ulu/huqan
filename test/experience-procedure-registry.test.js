'use strict';

/**
 * Procedure Registry tests (#2393, design comment on #2382, R3 Phase 6).
 *
 * Implements the 7 acceptance tests listed at the end of #2382's design
 * comment, in order.
 *
 * Hermetic: no I/O, no storage, no timers. Uses real `compiler.js`
 * `compile()`/`qualify()` output rather than hand-rolled fixtures, per the
 * design comment's "no new instrumentation, computable directly from
 * qualify()'s existing output."
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { compile, qualify, KINDS } = require('../lib/experience/compiler');
const {
  createProcedureRegistry,
  CODES,
} = require('../lib/experience/procedure-registry');

const PROVENANCE = Object.freeze({ sourceSha: 'sha-1', procedureVersion: '1', configHash: 'cfg-1' });

function candidate(sources = ['src-1']) {
  return Object.freeze({
    status: 'candidate',
    trace: Object.freeze({
      sources: Object.freeze([...sources]),
      scope: Object.freeze({ repo: 'huqan' }),
      revision: 'rev-1',
    }),
  });
}

function compileReplaceText(overrides = {}) {
  const result = compile({
    candidate: candidate(),
    kind: KINDS.REPLACE_TEXT,
    params: { path: 'a.txt', oldText: 'foo', newText: 'bar' },
    parentVersion: 0,
    ...overrides,
  });
  assert.equal(result.ok, true, 'fixture compile() must succeed');
  return result.procedure;
}

/** Single-site apply: exactly one match, replaced cleanly. */
function applySingleSite(procedure, input) {
  return { sites: 1, after: input.replace(procedure.params.oldText, procedure.params.newText) };
}

/** Ambiguous apply: reports two match sites. */
function applyAmbiguous() {
  return { sites: 2, after: 'unchanged' };
}

describe('Procedure Registry: acceptance tests (#2382 design comment)', () => {
  it('1. register() with real compile() output round-trips unchanged through get()', () => {
    const registry = createProcedureRegistry();
    const procedure = compileReplaceText();

    const registered = registry.register({ workspaceId: 'ws-a', procedure, provenance: PROVENANCE });
    assert.equal(registered.ok, true);
    assert.equal(registered.idempotent, false);

    const fetched = registry.get({ workspaceId: 'ws-a', kind: procedure.kind, version: procedure.version });
    assert.equal(fetched.ok, true);
    assert.equal(fetched.entry.hash, procedure.hash);
    assert.deepEqual(fetched.entry.params, procedure.params);
    assert.deepEqual(fetched.entry.preconditions, procedure.preconditions);
    assert.deepEqual(fetched.entry.postconditions, procedure.postconditions);
    assert.deepEqual(fetched.entry.evidenceRefs, procedure.evidenceRefs);
    assert.deepEqual(fetched.entry.scope, procedure.scope);
    assert.equal(fetched.entry.revision, procedure.revision);
    assert.equal(fetched.entry.version, procedure.version);
  });

  it('2. same (workspaceId, kind, version) registered twice with identical content -> idempotent success', () => {
    const registry = createProcedureRegistry();
    const procedure = compileReplaceText();

    const first = registry.register({ workspaceId: 'ws-a', procedure, provenance: PROVENANCE });
    const second = registry.register({ workspaceId: 'ws-a', procedure, provenance: PROVENANCE });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.idempotent, true);
    assert.equal(first.entry.hash, second.entry.hash);
    assert.equal(first.entry.registeredAt, second.entry.registeredAt, 'must not create a new entry');
  });

  it('3. same key, different hash -> refused with a tamper-shaped code, not silently overwritten', () => {
    const registry = createProcedureRegistry();
    const procedure = compileReplaceText();
    registry.register({ workspaceId: 'ws-a', procedure, provenance: PROVENANCE });

    // Same (kind, version) but a different hash — simulate tampering by
    // freezing a copy with an altered hash rather than the compiled one.
    const tampered = Object.freeze({ ...procedure, hash: `${procedure.hash}-tampered` });
    const result = registry.register({ workspaceId: 'ws-a', procedure: tampered, provenance: PROVENANCE });

    assert.equal(result.ok, false);
    assert.equal(result.code, CODES.TAMPER_DETECTED);
    assert.notEqual(result.code, CODES.NOT_FOUND);

    const stillOriginal = registry.get({ workspaceId: 'ws-a', kind: procedure.kind, version: procedure.version });
    assert.equal(stillOriginal.entry.hash, procedure.hash, 'stored entry must not be overwritten');
  });

  it('4. cross-workspace registration or lookup is refused, never bleeds between workspaces', () => {
    const registry = createProcedureRegistry();
    const procedure = compileReplaceText();
    registry.register({ workspaceId: 'ws-a', procedure, provenance: PROVENANCE });

    const crossLookup = registry.get({ workspaceId: 'ws-b', kind: procedure.kind, version: procedure.version });
    assert.equal(crossLookup.ok, false);
    assert.equal(crossLookup.code, CODES.NOT_FOUND);

    // Hard-assert: a malformed/empty workspaceId throws rather than being
    // silently treated as some shared/default namespace other callers
    // could collide into.
    assert.throws(() => registry.get({ workspaceId: '', kind: procedure.kind, version: procedure.version }), TypeError);
    assert.throws(() => registry.register({ workspaceId: null, procedure, provenance: PROVENANCE }), TypeError);
  });

  it('5. an old version remains fetchable by its own version number after a newer version becomes active', () => {
    const registry = createProcedureRegistry();
    const v1 = compileReplaceText({ parentVersion: 0 });
    const v2 = compileReplaceText({
      parentVersion: v1.version,
      params: { path: 'a.txt', oldText: 'bar', newText: 'baz' },
    });

    registry.register({ workspaceId: 'ws-a', procedure: v1, provenance: PROVENANCE });
    registry.register({ workspaceId: 'ws-a', procedure: v2, provenance: PROVENANCE });
    // Activation is gated on version-bound qualification evidence (#3460).
    const passing = qualify({
      procedure: v2, inputs: ['line with bar in it'], apply: applySingleSite, observe: (input) => input,
    });
    assert.equal(passing.ok, true);
    registry.recordQualification({ workspaceId: 'ws-a', kind: v2.kind, version: v2.version, details: passing });

    const activated = registry.setActiveVersion({ workspaceId: 'ws-a', kind: v2.kind, version: v2.version });
    assert.equal(activated.ok, true);
    assert.equal(registry.getActiveVersion({ workspaceId: 'ws-a', kind: v2.kind }).version, v2.version);

    const oldFetch = registry.get({ workspaceId: 'ws-a', kind: v1.kind, version: v1.version });
    assert.equal(oldFetch.ok, true);
    assert.equal(oldFetch.entry.hash, v1.hash, 'old version payload must never become the new one');
    assert.notEqual(oldFetch.entry.hash, v2.hash);
  });

  it('8. activation fails closed without qualification evidence, and evidence is bound to the exact hash', () => {
    const registry = createProcedureRegistry();
    const v1 = compileReplaceText({ parentVersion: 0 });
    const v2 = compileReplaceText({
      parentVersion: v1.version,
      params: { path: 'a.txt', oldText: 'bar', newText: 'baz' },
    });
    registry.register({ workspaceId: 'ws-a', procedure: v1, provenance: PROVENANCE });
    registry.register({ workspaceId: 'ws-a', procedure: v2, provenance: PROVENANCE });

    // Registered is not qualified: activation without evidence is refused.
    const unproven = registry.setActiveVersion({ workspaceId: 'ws-a', kind: v2.kind, version: v2.version });
    assert.equal(unproven.ok, false);
    assert.equal(unproven.code, CODES.QUALIFICATION_MISSING);
    assert.equal(registry.getActiveVersion({ workspaceId: 'ws-a', kind: v2.kind }).code, CODES.NO_ACTIVE_VERSION);

    // Evidence recorded against v1 must not authorize v2: the binding is the
    // version's own immutable hash, not the kind.
    const passV1 = qualify({
      procedure: v1, inputs: ['line with foo in it'], apply: applySingleSite, observe: (input) => input,
    });
    assert.equal(passV1.ok, true);
    registry.recordQualification({ workspaceId: 'ws-a', kind: v1.kind, version: v1.version, details: passV1 });
    assert.equal(registry.setActiveVersion({ workspaceId: 'ws-a', kind: v2.kind, version: v2.version }).code,
      CODES.QUALIFICATION_MISSING);
    assert.equal(registry.setActiveVersion({ workspaceId: 'ws-a', kind: v1.kind, version: v1.version }).ok, true);

    // A rejecting outcome is not evidence, even when bound to the version.
    registry.recordQualification({ workspaceId: 'ws-a', kind: v2.kind, version: v2.version, details: { ok: false, code: 'qualify_rejected:drift' } });
    assert.equal(registry.setActiveVersion({ workspaceId: 'ws-a', kind: v2.kind, version: v2.version }).code,
      CODES.QUALIFICATION_MISSING);

    // A passing result for a DIFFERENT version, submitted under v3's version
    // key, must not authorize v3: the evidence hash has to match the entry.
    const v3 = compileReplaceText({
      parentVersion: v2.version, params: { path: 'a.txt', oldText: 'baz', newText: 'qux' },
    });
    registry.register({ workspaceId: 'ws-a', procedure: v3, provenance: PROVENANCE });
    registry.recordQualification({ workspaceId: 'ws-a', kind: v3.kind, version: v3.version, details: passV1 });
    assert.equal(registry.setActiveVersion({ workspaceId: 'ws-a', kind: v3.kind, version: v3.version }).code,
      CODES.QUALIFICATION_MISSING, 'a pass whose procedureHash names another version is not evidence');
  });

  it('9. a promotion can be rolled back to the previously active version, and the undo is auditable', () => {
    const registry = createProcedureRegistry();
    const v1 = compileReplaceText({ parentVersion: 0 });
    const v2 = compileReplaceText({
      parentVersion: v1.version,
      params: { path: 'a.txt', oldText: 'bar', newText: 'baz' },
    });
    registry.register({ workspaceId: 'ws-a', procedure: v1, provenance: PROVENANCE });
    registry.register({ workspaceId: 'ws-a', procedure: v2, provenance: PROVENANCE });
    for (const [procedure, input] of [[v1, 'line with foo in it'], [v2, 'line with bar in it']]) {
      const pass = qualify({ procedure, inputs: [input], apply: applySingleSite, observe: (value) => value });
      registry.recordQualification({ workspaceId: 'ws-a', kind: procedure.kind, version: procedure.version, details: pass });
    }

    // First activation has no prior version to fall back to.
    assert.equal(registry.rollbackActiveVersion({ workspaceId: 'ws-a', kind: v1.kind }).code, CODES.NO_ROLLBACK_TARGET);

    registry.setActiveVersion({ workspaceId: 'ws-a', kind: v1.kind, version: v1.version });
    registry.setActiveVersion({ workspaceId: 'ws-a', kind: v2.kind, version: v2.version });
    assert.equal(registry.getActiveVersion({ workspaceId: 'ws-a', kind: v1.kind }).version, v2.version);

    // Re-activating the already-active version is a no-op, not a `v2 -> v2`
    // record that would later swallow a rollback.
    const retry = registry.setActiveVersion({ workspaceId: 'ws-a', kind: v1.kind, version: v2.version });
    assert.equal(retry.ok, true);
    assert.equal(retry.idempotent, true);

    const rolledBack = registry.rollbackActiveVersion({ workspaceId: 'ws-a', kind: v1.kind });
    assert.equal(rolledBack.ok, true);
    assert.equal(rolledBack.activeVersion, v1.version);
    assert.equal(registry.getActiveVersion({ workspaceId: 'ws-a', kind: v1.kind }).version, v1.version);

    // The undo is consumed: a second rollback must not reactivate v2.
    assert.equal(registry.rollbackActiveVersion({ workspaceId: 'ws-a', kind: v1.kind }).code,
      CODES.NO_ROLLBACK_TARGET);
    assert.equal(registry.getActiveVersion({ workspaceId: 'ws-a', kind: v1.kind }).version, v1.version);

    // History is append-only and records the real moves, in order.
    const history = registry.getRollbackHistory({ workspaceId: 'ws-a', kind: v1.kind });
    assert.deepEqual(history.entries.map((entry) => [entry.fromVersion, entry.toVersion]),
      [[null, v1.version], [v1.version, v2.version], [v2.version, v1.version]]);
  });

  it('6. coverage gate refuses a kind with zero recorded drift/ambiguous rejections, even with a passing qualify()', () => {
    const registry = createProcedureRegistry();
    const procedure = compileReplaceText();
    registry.register({ workspaceId: 'ws-a', procedure, provenance: PROVENANCE });

    const passing = qualify({
      procedure,
      inputs: ['line with foo in it'],
      apply: applySingleSite,
      observe: (input) => input,
    });
    assert.equal(passing.ok, true, 'fixture qualify() must pass to prove the gate blocks even on a pass');

    registry.recordQualification({
      workspaceId: 'ws-a', kind: procedure.kind, at: Date.now(), details: passing,
    });

    const gate = registry.evaluateCoverageGate({ workspaceId: 'ws-a', kind: procedure.kind });
    assert.equal(gate.ok, true);
    assert.equal(gate.admissible, false);
    assert.equal(gate.code, CODES.COVERAGE_INSUFFICIENT);
    assert.deepEqual(gate.missing.sort(), ['qualify_rejected:ambiguous', 'qualify_rejected:drift']);
  });

  it('7. coverage gate opens once both rejection paths have fired for the kind, on any candidate', () => {
    const registry = createProcedureRegistry();
    const candidateA = compileReplaceText();
    const candidateB = compileReplaceText({ parentVersion: 5 });
    registry.register({ workspaceId: 'ws-a', procedure: candidateA, provenance: PROVENANCE });
    registry.register({ workspaceId: 'ws-a', procedure: candidateB, provenance: PROVENANCE });

    // Drift fires against candidateA: oldText absent from the observed input.
    const drifted = qualify({
      procedure: candidateA,
      inputs: ['no match here'],
      apply: applySingleSite,
      observe: (input) => input,
    });
    assert.equal(drifted.code, 'qualify_rejected:drift');
    registry.recordQualification({ workspaceId: 'ws-a', kind: candidateA.kind, details: drifted });

    let gate = registry.evaluateCoverageGate({ workspaceId: 'ws-a', kind: candidateA.kind });
    assert.equal(gate.admissible, false, 'only one of the two rejection paths has fired so far');

    // Ambiguous fires against candidateB: two match sites reported.
    const ambiguous = qualify({
      procedure: candidateB,
      inputs: ['line with foo in it'],
      apply: applyAmbiguous,
      observe: (input) => input,
    });
    assert.equal(ambiguous.code, 'qualify_rejected:ambiguous');
    registry.recordQualification({ workspaceId: 'ws-a', kind: candidateB.kind, details: ambiguous });

    gate = registry.evaluateCoverageGate({ workspaceId: 'ws-a', kind: candidateA.kind });
    assert.equal(gate.ok, true);
    assert.equal(gate.admissible, true, 'both paths fired on the kind, regardless of which candidate');
    assert.deepEqual(gate.missing, []);

    // Independent of which candidate later gets promoted: candidateB's own
    // coverage read (same workspace + kind) is identical.
    const gateForB = registry.evaluateCoverageGate({ workspaceId: 'ws-a', kind: candidateB.kind });
    assert.equal(gateForB.admissible, true);
  });

  it('#3465 register() refuses a missing provenance stamp and stores nothing', () => {
    const registry = createProcedureRegistry();
    const procedure = compileReplaceText();
    const none = registry.register({ workspaceId: 'ws-a', procedure });
    assert.equal(none.ok, false);
    assert.equal(none.code, CODES.PROVENANCE_MISSING);
    assert.deepEqual(none.missing, ['sourceSha', 'procedureVersion', 'configHash']);
    const partial = registry.register({ workspaceId: 'ws-a', procedure, provenance: { sourceSha: 'x', configHash: '' } });
    assert.deepEqual(partial.missing, ['procedureVersion', 'configHash']);
    assert.equal(registry.get({ workspaceId: 'ws-a', kind: procedure.kind, version: procedure.version }).code, CODES.NOT_FOUND);
  });

  it('#3465 the stamp is stored on the entry and kept on idempotent re-register', () => {
    const registry = createProcedureRegistry();
    const procedure = compileReplaceText();
    registry.register({ workspaceId: 'ws-a', procedure, provenance: PROVENANCE });
    const again = registry.register({ workspaceId: 'ws-a', procedure, provenance: { ...PROVENANCE, sourceSha: 'sha-2' } });
    assert.equal(again.idempotent, true);
    assert.deepEqual(again.entry.provenance, PROVENANCE);
  });

  it('#3465 override is an explicit audited event, needs actor+reason, and is undoable', () => {
    const registry = createProcedureRegistry();
    const v1 = compileReplaceText();
    const v2 = compileReplaceText({ parentVersion: 1 });
    registry.register({ workspaceId: 'ws-a', procedure: v1, provenance: PROVENANCE });
    registry.register({ workspaceId: 'ws-a', procedure: v2, provenance: PROVENANCE });
    const key = { workspaceId: 'ws-a', kind: v1.kind };
    assert.equal(registry.overrideActiveVersion({ ...key, version: v1.version, actor: 'op' }).code, CODES.OVERRIDE_REASON_MISSING);
    assert.equal(registry.overrideActiveVersion({ ...key, version: 99, actor: 'op', reason: 'r' }).code, CODES.NOT_FOUND);
    assert.equal(registry.setActiveVersion({ ...key, version: v1.version }).code, CODES.QUALIFICATION_MISSING);
    assert.equal(registry.overrideActiveVersion({ ...key, version: v1.version, actor: 'op', reason: 'hotfix' }).ok, true);
    assert.equal(registry.overrideActiveVersion({ ...key, version: v2.version, actor: 'op', reason: 'again' }).ok, true);
    assert.equal(registry.rollbackActiveVersion(key).activeVersion, v1.version);
    const kinds = registry.getRollbackHistory(key).entries.map((e) => e.kind);
    assert.deepEqual(kinds, ['override', 'override', 'rollback']);
    assert.equal(registry.getRollbackHistory(key).entries[0].reason, 'hotfix');
  });
});

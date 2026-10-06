'use strict';

/**
 * Characterization tests for scoped defeasible intake (#3497, R42).
 *
 * These pin the contract, not the prover: proof *production* stays separate
 * from learning *intake*, a defeater is only ever issued inside a scope that
 * declared itself closed, and semantic dominance marks a weaker record instead
 * of deleting it. The negative cases matter most — an open-world absence must
 * never read as a refutation, and `unknown`/`stopped` must never read as false.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { proveFromRules } = require('../lib/inference-runtime');
const { variable, constant, atom } = require('../lib/inference-rule-ir');
const {
  SCHEMA_VERSION,
  PROOF_CLASS,
  INTAKE_SIGNAL,
  INTAKE_REASON,
  normalizeScope,
  classifyProof,
  describeClaim,
  deriveScopedIntake,
  applySemanticDominance,
} = require('../lib/inference-defeasible-scope');

function fact(predicate, ...values) {
  return { predicate, args: values.map(constant) };
}

function transitiveRule() {
  const X = variable('X'); const Y = variable('Y'); const Z = variable('Z');
  return { id: 'r-transitive', head: atom('edge', [X, Z]), body: [atom('edge', [X, Y]), atom('edge', [Y, Z])] };
}

const RULES = [transitiveRule()];
const FACTS = [fact('edge', 'a', 'b'), fact('edge', 'b', 'c')];
const QUERY = fact('edge', 'a', 'c');

function prove(query, facts = FACTS, rules = RULES) {
  return proveFromRules({ query, facts, rules }, { limits: { maxOperations: 1000, maxDepth: 50, timeoutMs: 5000 } });
}

test('a proven fact is positive evidence and carries its scope', () => {
  const result = prove(QUERY);
  assert.equal(result.status, 'proven');
  const record = deriveScopedIntake({ status: result.status, reason: result.reason, proof: result.proof, scope: { scopeId: 'kb-1' } });
  assert.equal(record.schemaVersion, SCHEMA_VERSION);
  assert.equal(record.proof.class, PROOF_CLASS.PROVEN);
  assert.equal(record.intake.signal, INTAKE_SIGNAL.POSITIVE);
  assert.equal(record.intake.reason, INTAKE_REASON.PROVEN_IN_SCOPE);
  assert.equal(record.defeater, null);
  assert.equal(record.registered, false);
  assert.equal(record.deleted, false);
  assert.equal(record.scope.scopeId, 'kb-1');
  assert.equal(record.scope.closedWorld, false);
});

test('not_proven in an OPEN scope is an absence, not a refutation', () => {
  const result = prove(fact('missing', 'a', 'z'));
  assert.equal(result.status, 'not_proven');
  const record = deriveScopedIntake({ status: result.status, reason: result.reason, proof: result.proof, scope: { scopeId: 'kb-1' } });
  assert.equal(record.intake.signal, INTAKE_SIGNAL.NONE, 'open-world absence yields no evidence');
  assert.equal(record.intake.reason, INTAKE_REASON.OPEN_WORLD_ABSENCE);
  assert.equal(record.defeater, null, 'an open scope never issues a defeater');
});

test('not_proven in a CLOSED scope is scoped negative evidence', () => {
  const result = prove(fact('missing', 'a', 'z'));
  const record = deriveScopedIntake({ status: result.status, reason: result.reason, proof: result.proof, scope: { scopeId: 'kb-1', closedWorld: true } });
  assert.equal(record.intake.signal, INTAKE_SIGNAL.NEGATIVE);
  assert.equal(record.intake.reason, INTAKE_REASON.CLOSED_WORLD_ABSENCE);
  assert.ok(record.defeater);
  assert.equal(record.defeater.scoped, true);
  assert.equal(record.defeater.scopeId, 'kb-1', 'the defeater names the scope it belongs to');
  assert.equal(record.defeater.kind, 'negation_as_failure');
});

test('a defeater from one scope is not a defeater in another', () => {
  const result = prove(fact('missing', 'a', 'z'));
  const closed = deriveScopedIntake({ status: result.status, reason: result.reason, proof: result.proof, scope: { scopeId: 'closed', closedWorld: true } });
  const open = deriveScopedIntake({ status: result.status, reason: result.reason, proof: result.proof, scope: { scopeId: 'open' } });
  assert.equal(closed.defeater.scopeId, 'closed');
  assert.equal(open.defeater, null);
  assert.notEqual(closed.intake.signal, open.intake.signal);
});

test('a defeater names the claim it is over, so two absences stay distinguishable', () => {
  const scope = { scopeId: 'kb-1', closedWorld: true };
  const first = deriveScopedIntake({ status: 'not_proven', claim: fact('edge', 'a', 'z'), scope });
  const second = deriveScopedIntake({ status: 'not_proven', claim: fact('edge', 'b', 'z'), scope });
  assert.equal(first.claim, 'edge(a, z)');
  assert.equal(first.defeater.claim, 'edge(a, z)');
  assert.notEqual(first.defeater.claim, second.defeater.claim, 'same scope and reason, different claims');
  assert.equal(first.defeater.scopeId, second.defeater.scopeId);
  assert.equal(first.defeater.reason, second.defeater.reason);
});

test('describeClaim renders the rule-IR atom and refuses a non-atom', () => {
  assert.equal(describeClaim(fact('edge', 'a', 'c')), 'edge(a, c)');
  assert.equal(describeClaim('edge(a, c)'), 'edge(a, c)');
  assert.equal(describeClaim({ predicate: 'p', args: [variable('X')] }), 'p(X)');
  assert.equal(describeClaim({ predicate: 'p', args: [] }), 'p', 'an atom with no args is just its predicate');
  assert.equal(describeClaim({ predicate: 'p', args: ['a', 7, true] }), 'p(a, 7, true)', 'raw scalars render directly');
  assert.equal(describeClaim({ predicate: 'p', args: [null, { kind: 'unknown' }] }), 'p(_, _)', 'unreadable terms degrade to a placeholder');
  assert.equal(describeClaim({ predicate: 'p', args: [undefined] }), 'p(_)');
  assert.equal(describeClaim({ predicate: 'p', args: 'x' }), 'p', 'a non-array args field is treated as empty');
  assert.equal(describeClaim(null), null);
  assert.equal(describeClaim(undefined), null);
  assert.throws(() => describeClaim(42), /claim must be an atom/);
  assert.throws(() => describeClaim({}), /claim\.predicate must be a non-empty string/);
});

test('unknown and stopped proofs are never read as false', () => {
  for (const status of ['unknown', 'stopped']) {
    const record = deriveScopedIntake({ status, scope: { scopeId: 'kb-1', closedWorld: true } });
    assert.equal(record.intake.signal, INTAKE_SIGNAL.NONE, `${status} yields no evidence even in a closed scope`);
    assert.equal(record.defeater, null, `${status} never issues a defeater`);
  }
  assert.equal(deriveScopedIntake({ status: 'unknown', scope: { scopeId: 's' } }).intake.reason, INTAKE_REASON.PROOF_UNKNOWN);
  assert.equal(deriveScopedIntake({ status: 'stopped', scope: { scopeId: 's' } }).intake.reason, INTAKE_REASON.PROOF_STOPPED);
});

test('an unrecognised prover status degrades to invalid, not to not_proven', () => {
  assert.equal(classifyProof('nonsense'), PROOF_CLASS.INVALID);
  const record = deriveScopedIntake({ status: 'nonsense', scope: { scopeId: 's', closedWorld: true } });
  assert.equal(record.proof.class, PROOF_CLASS.INVALID);
  assert.equal(record.intake.reason, INTAKE_REASON.PROOF_INVALID);
  assert.equal(record.intake.signal, INTAKE_SIGNAL.NONE);
});

test('scope normalization defaults to open and refuses a non-boolean closedWorld', () => {
  const scope = normalizeScope({ scopeId: 's' });
  assert.equal(scope.closedWorld, false, 'silence means open, never closed');
  assert.deepEqual(scope.ruleIds, []);
  assert.deepEqual(scope.factRefs, []);
  assert.throws(() => normalizeScope({ scopeId: 's', closedWorld: 'yes' }), /closedWorld must be a boolean/);
  assert.throws(() => normalizeScope({}), /scopeId must be a non-empty string/);
});

test('provenance merges the declared scope rules with the rules the proof used', () => {
  const result = prove(QUERY);
  const record = deriveScopedIntake({
    status: result.status, reason: result.reason, proof: result.proof, proofRef: 'trace-1',
    scope: { scopeId: 'kb-1', ruleIds: ['r-declared'] },
  });
  assert.deepEqual(record.provenance.ruleIds, ['r-declared', 'r-transitive']);
  assert.equal(record.provenance.proofRef, 'trace-1');
  assert.ok(record.provenance.proofDepth >= 1, 'the transitive proof has depth');
});

test('semantic dominance marks a weaker record instead of deleting it', () => {
  const weaker = { recordId: 'f-weak', state: 'active', fact: 'edge(a,b)', provenance: { source: 'kb-1' } };
  const out = applySemanticDominance({ existing: weaker, dominator: { recordId: 'f-strong' }, at: '2026-10-06T00:00:00Z', reason: 'stronger_claim' });
  assert.equal(out.deleted, false, 'physical deletion is out of scope');
  assert.equal(out.action, 'marked_superseded');
  assert.equal(out.record.state, 'superseded');
  assert.equal(out.record.dominatedBy, 'f-strong');
  assert.equal(out.record.dominanceReason, 'stronger_claim');
  assert.equal(out.record.dominatedAt, '2026-10-06T00:00:00Z');
  assert.deepEqual(out.record.provenance, { source: 'kb-1' }, 'provenance is preserved');
  assert.equal(weaker.state, 'active', 'the input is not mutated');
});

test('semantic dominance refuses a self-domination', () => {
  assert.throws(
    () => applySemanticDominance({ existing: { recordId: 'x' }, dominator: { recordId: 'x' } }),
    /cannot dominate itself/,
  );
});

test('a malformed input is refused rather than silently admitted', () => {
  assert.throws(() => deriveScopedIntake(null), /input must be an object/);
  assert.throws(() => deriveScopedIntake({ status: 'proven' }), /scopeId must be a non-empty string/);
  assert.throws(() => deriveScopedIntake({ status: 'proven', scope: 'kb-1' }), /scope must be an object/);
  assert.throws(() => deriveScopedIntake({ status: 'proven', scope: { scopeId: '' } }), /scopeId must be a non-empty string/);
  assert.throws(() => normalizeScope({ scopeId: 's', ruleIds: 'r1' }), /scope.ruleIds must be an array/);
});

test('a scope carries an optional workspace and a defeater falls back to no_proof', () => {
  const scoped = normalizeScope({ scopeId: 's', workspaceId: 'w' });
  assert.equal(scoped.workspaceId, 'w');
  assert.equal(normalizeScope({ scopeId: 's' }).workspaceId, null);
  assert.throws(() => normalizeScope({ scopeId: 's', workspaceId: '' }), /scope.workspaceId must be a non-empty string/);

  // A closed scope with no prover reason still records a stable defeater reason.
  const record = deriveScopedIntake({ status: 'not_proven', scope: { scopeId: 's', closedWorld: true } });
  assert.equal(record.defeater.reason, 'no_proof');
});

test('semantic dominance accepts an `id` field and defaults its clock and reason', () => {
  const out = applySemanticDominance({ existing: { id: 'f-weak' }, dominator: { id: 'f-strong' } });
  assert.equal(out.record.recordId, 'f-weak');
  assert.equal(out.record.dominatedBy, 'f-strong');
  assert.equal(out.record.dominatedAt, null, 'a missing clock is explicit, not guessed');
  assert.equal(out.record.dominanceReason, 'semantic_dominance');
});

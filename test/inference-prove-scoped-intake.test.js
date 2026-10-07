'use strict';

// #3497: kernel.prove carries the scoped intake reading of its proof, kept
// apart from the proof. Open-world by default, so "not proven" is never read
// as "false" unless the caller declares the scope closed; nothing is
// registered.

const assert = require('node:assert/strict');
const test = require('node:test');

const Kernel = require('../kernel');
const { variable, atom } = require('../lib/inference-rule-ir');
const { INTAKE_SIGNAL, intakeForProve } = require('../lib/inference-defeasible-scope');

function affectsRule() {
  const X = variable('X'); const Y = variable('Y'); const Z = variable('Z');
  return { id: 'rule:affects-through-type', head: atom('affects', [X, Z]), body: [atom('CAUSES', [X, Y]), atom('is_a', [Y, Z])] };
}

const FACTS = [
  { predicate: 'CAUSES', from: 'smoking', to: 'cancer' },
  { predicate: 'is_a', from: 'cancer', to: 'disease' },
];

function withKernel(fn) {
  const kernel = new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false, memoryStoreUseSQLite: false });
  try {
    return fn(kernel);
  } finally {
    kernel.graph.close();
  }
}

test('a proven fact is positive evidence in the scope it was proven in', () => withKernel((kernel) => {
  const result = kernel.prove({ rules: [affectsRule()], facts: FACTS, query: { predicate: 'affects', from: 'smoking', to: 'disease' } });
  assert.equal(result.data.status, 'proven');
  const { intake } = result.data;
  assert.equal(intake.intake.signal, INTAKE_SIGNAL.POSITIVE);
  assert.equal(intake.registered, false, 'nothing is registered');
  assert.deepEqual([...intake.scope.ruleIds], ['rule:affects-through-type']);
  assert.match(intake.scope.scopeId, /^prove:[0-9a-f]{16}$/);
  assert.equal(intake.scope.closedWorld, false);
  assert.ok(result.data.proof, 'the proof stays its own field');
}));

test('not proven is no evidence in an open world and scoped negative only when declared closed', () => withKernel((kernel) => {
  const query = { predicate: 'affects', from: 'smoking', to: 'bananas' };
  const open = kernel.prove({ rules: [affectsRule()], facts: FACTS, query });
  assert.equal(open.data.status, 'not_proven');
  assert.equal(open.data.intake.intake.signal, INTAKE_SIGNAL.NONE, 'absence in an open world is not falsity');

  const closed = kernel.prove({ rules: [affectsRule()], facts: FACTS, query, scope: { scopeId: 'lab-closed', closedWorld: true } });
  assert.equal(closed.data.intake.intake.signal, INTAKE_SIGNAL.NEGATIVE);
  assert.equal(closed.data.intake.scope.scopeId, 'lab-closed', 'the defeater names its scope');
}));

test('the derived scope id is deterministic for the same rules and facts', () => withKernel((kernel) => {
  const input = { rules: [affectsRule()], facts: FACTS, query: { predicate: 'affects', from: 'smoking', to: 'disease' } };
  const a = kernel.prove(input).data.intake.scope.scopeId;
  const b = kernel.prove(input).data.intake.scope.scopeId;
  const c = kernel.prove({ ...input, facts: FACTS.slice(0, 1) }).data.intake.scope.scopeId;
  assert.equal(a, b);
  assert.notEqual(a, c, 'different facts are a different scope');
  // Same rule id, different body: a different scope. Order does not matter.
  const X = variable('X'); const Z = variable('Z');
  const otherBody = { ...affectsRule(), body: [atom('CAUSES', [X, Z])] };
  const d = kernel.prove({ ...input, rules: [otherBody] }).data.intake.scope.scopeId;
  assert.notEqual(a, d, 'a different rule body is a different scope');
  const reordered = kernel.prove({ ...input, facts: [...FACTS].reverse() }).data.intake.scope.scopeId;
  assert.equal(a, reordered, 'fact order does not change the scope');
}));

test('the call workspace is authoritative over the scope workspace', () => {
  const result = { status: 'proven' };
  assert.equal(intakeForProve({ workspaceId: 'w-call', scope: { workspaceId: 'w-scope' } }, result).scope.workspaceId, 'w-call');
  assert.equal(intakeForProve({ scope: { workspaceId: 'w-scope' } }, result).scope.workspaceId, 'w-scope');
  assert.equal(intakeForProve({}, result).scope.workspaceId, null);
});

test('only a declared boolean closes the world, and a malformed input yields no intake', () => {
  // A non-boolean closedWorld is not a declaration: the world stays open.
  assert.equal(intakeForProve({ scope: { closedWorld: 'yes' }, rules: [] }, { status: 'not_proven' }).intake.signal, INTAKE_SIGNAL.NONE);
  // A non-string scopeId falls back to the derived one.
  assert.match(intakeForProve({ scope: { scopeId: 5 }, rules: [] }, { status: 'proven' }).scope.scopeId, /^prove:/);
  // A result the classifier cannot read yields null, never evidence.
  assert.equal(intakeForProve({ rules: [] }, null), null);
  assert.equal(intakeForProve(null, { status: 'proven' }).intake.signal, INTAKE_SIGNAL.POSITIVE);
});

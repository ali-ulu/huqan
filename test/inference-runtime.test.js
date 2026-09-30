'use strict';

/**
 * Production reachability for the inference layer (#3038).
 *
 * The inference primitives were already unit tested in isolation. What was
 * missing is a product caller: before this, nothing outside test/ executed
 * lib/inference-*.js, and every module in the family was NOT_YET_WIRED. These
 * tests drive the real production path -- kernel.derive / kernel.prove and the
 * lib/inference-runtime.js entry they delegate to -- rather than the primitives
 * directly, so a regression that unhooks the runtime fails here.
 *
 * The admission cases use the real candidate ingress
 * (`kernel.ingestCandidateClaim`) with an injected admission evaluator, exactly
 * as test/inference-derived-provenance.test.js does. No graph write is faked:
 * the assertions read the graph back.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const Kernel = require('../kernel');
const { callTool } = require('../mcpServer');
const { variable, constant, atom } = require('../lib/inference-rule-ir');
const { deriveFromRules, proveFromRules, RUNTIME_STATUS } = require('../lib/inference-runtime');

const DERIVED_AT = '2026-09-30T00:00:00.000Z';

function fact(predicate, ...values) {
  return { predicate, args: values.map(constant) };
}

function affectsRule() {
  const X = variable('X'); const Y = variable('Y'); const Z = variable('Z');
  return {
    id: 'rule:affects-through-type',
    head: atom('affects', [X, Z]),
    body: [atom('CAUSES', [X, Y]), atom('is_a', [Y, Z])],
  };
}

function compactFacts() {
  return [
    { predicate: 'CAUSES', from: 'smoking', to: 'cancer' },
    { predicate: 'is_a', from: 'cancer', to: 'disease' },
  ];
}

function newKernel() {
  return new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false, memoryStoreUseSQLite: false });
}

function forcedAllowAdmission(record) {
  const receiptId = `receipt_${record.derivationId.slice(5, 21)}`;
  return {
    outcome: 'allow',
    reason: 'test_allow',
    graphWrite: true,
    workspaceId: record.workspaceId,
    provenanceId: record.derivationId,
    receiptId,
    trustPolicyVersion: 'test-policy-v1',
    receipt: {
      receiptId,
      receiptKind: 'memory_admission_receipt',
      decision: 'allow',
      status: 'admitted',
      admissionId: `admission_${record.derivationId.slice(5, 21)}`,
      workspaceId: record.workspaceId,
      provenanceId: record.derivationId,
      trustPolicyVersion: 'test-policy-v1',
      createdAt: DERIVED_AT,
    },
  };
}

test('a general rule with variables derives a previously unstored fact', () => {
  const result = deriveFromRules(
    { rules: [affectsRule()], facts: compactFacts(), workspaceId: 'ws-inference' },
    { limits: { timeoutMs: 5000 } },
  );

  assert.equal(result.status, RUNTIME_STATUS.COMPLETE);
  assert.equal(result.stoppedReason, 'fixpoint');
  assert.equal(result.derivedFacts.length, 1);
  const [derived] = result.derivedFacts;
  assert.equal(derived.ruleId, 'rule:affects-through-type');
  assert.deepEqual(derived.fact, { predicate: 'affects', from: 'smoking', to: 'disease' });
  assert.equal(derived.state, 'provisional');
  assert.equal(derived.canonicalWrite, false);
  assert.match(derived.derivationId, /^prov_[0-9a-f]{32}$/);
});

test('the derivation is reproducible from the graph snapshot + rule set alone', () => {
  const input = {
    rules: [affectsRule()],
    facts: compactFacts(),
    workspaceId: 'ws-inference',
    graphSnapshotId: 'graph-snapshot-001',
    ruleSnapshotId: 'rule-snapshot-001',
  };
  const left = deriveFromRules(input, { now: DERIVED_AT });
  const right = deriveFromRules(input, { now: '2026-09-30T09:00:00.000Z' });

  assert.equal(left.snapshot.graphSnapshotId, 'graph-snapshot-001');
  assert.equal(left.snapshot.ruleSnapshotId, 'rule-snapshot-001');
  // Same snapshot + rule set => same derivation identity, even at a different wall clock.
  assert.equal(left.derivedFacts[0].derivationId, right.derivedFacts[0].derivationId);
  assert.deepEqual(left.derivedFacts, right.derivedFacts);
  assert.deepEqual(left.records[0].directSupportKeys, right.records[0].directSupportKeys);
});

test('a bounded budget that ran out is reported as stopped, never as a fixpoint', () => {
  const X = variable('X');
  const rules = [
    { id: 'rule:b-from-a', head: atom('b', [X]), body: [atom('a', [X])] },
    { id: 'rule:c-from-b', head: atom('c', [X]), body: [atom('b', [X])] },
  ];
  const result = deriveFromRules(
    { rules, facts: [fact('a', 'seed')], workspaceId: 'ws-inference' },
    { limits: { maxRounds: 1, timeoutMs: 5000 } },
  );

  assert.equal(result.status, RUNTIME_STATUS.STOPPED);
  assert.equal(result.stoppedReason, 'max_rounds');
  assert.equal(result.rounds, 1);
  assert.deepEqual(result.budget, { maxOperations: 100_000, maxRounds: 1, maxDerivedFacts: 10_000, timeoutMs: 5000 });
  // The stop reason is on the result, so "we ran out of budget" is never read as "we proved the fixpoint".
  assert.notEqual(result.stoppedReason, 'fixpoint');
});

test('a cyclic rule set terminates and exposes why it stopped', () => {
  const X = variable('X');
  const rules = [
    { id: 'rule:p-from-q', head: atom('p', [X]), body: [atom('q', [X])] },
    { id: 'rule:q-from-p', head: atom('q', [X]), body: [atom('p', [X])] },
  ];
  const result = proveFromRules(
    { rules, facts: [fact('seed', 'other')], query: fact('p', 'x') },
    { limits: { maxOperations: 5000, maxDepth: 16, timeoutMs: 5000 } },
  );

  // A cycle is an unfinished proof, so it is `unknown` with reason `cycle` --
  // not a silent `not_proven` downgrade to "false".
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'cycle');
  assert.equal(result.proof, null);
});

test('invalid rules are an explicit failure, not a silent empty derivation', () => {
  const result = deriveFromRules(
    { rules: [{ id: 'broken' }], facts: compactFacts(), workspaceId: 'ws-inference' },
    { limits: { timeoutMs: 5000 } },
  );

  assert.equal(result.status, RUNTIME_STATUS.INVALID);
  assert.equal(result.error.code, 'INVALID_INPUT');
  assert.deepEqual(result.derivedFacts, []);
});

test('kernel.derive is read-only by default: the derivation stays provisional and nothing is written', () => {
  const kernel = newKernel();
  try {
    const before = kernel.graph.getEdges('smoking', 'default');
    const result = kernel.derive(
      { rules: [affectsRule()], facts: compactFacts(), workspaceId: 'default' },
      { limits: { timeoutMs: 5000 } },
    );
    const after = kernel.graph.getEdges('smoking', 'default');

    assert.equal(result.ok, true);
    assert.equal(result.data.derivedFacts[0].state, 'provisional');
    assert.equal(result.data.admission.applied, false);
    assert.equal(after.length, before.length);
    assert.equal(after.some((edge) => edge.relation === 'affects' && edge.to === 'disease'), false);
  } finally {
    kernel.graph.close();
  }
});

test('admission only happens through the existing candidate ingress, and only then writes', () => {
  const kernel = newKernel();
  try {
    // Held path: admit requested, but the real admission evaluator does not allow it.
    const held = kernel.derive(
      { rules: [affectsRule()], facts: compactFacts(), workspaceId: 'default' },
      { admit: true, limits: { timeoutMs: 5000 } },
    );
    assert.equal(held.data.derivedFacts[0].state, 'provisional');
    assert.equal(held.data.derivedFacts[0].admissionStatus, 'held');
    assert.equal(held.data.admission.admittedCount, 0);
    assert.equal(
      kernel.graph.getEdges('smoking', 'default').some((edge) => edge.relation === 'affects' && edge.to === 'disease'),
      false,
    );

    // Allowed path: same ingress, admission evaluator forced to allow, so the
    // record transitions to admitted and the canonical edge lands with a receipt.
    const original = kernel._evaluateLearnAdmission.bind(kernel);
    kernel._inferenceAdmissionSeam = () => ({
      ingestCandidateClaim: (input, opts) => {
        const record = input.proposedEdge.derivation;
        kernel._evaluateLearnAdmission = () => forcedAllowAdmission(record);
        try {
          return kernel.ingestCandidateClaim(input, opts);
        } finally {
          kernel._evaluateLearnAdmission = original;
        }
      },
    });

    const admitted = kernel.derive(
      { rules: [affectsRule()], facts: compactFacts(), workspaceId: 'default' },
      { admit: true, now: DERIVED_AT, limits: { timeoutMs: 5000 } },
    );

    assert.equal(admitted.data.derivedFacts[0].state, 'admitted');
    assert.equal(admitted.data.derivedFacts[0].canonicalWrite, true);
    assert.equal(admitted.data.admission.admittedCount, 1);
    assert.match(admitted.data.derivedFacts[0].trustReceiptId, /^receipt_/);
    const edge = kernel.graph.getEdges('smoking', 'default')
      .find((item) => item.relation === 'affects' && item.to === 'disease');
    assert.ok(edge);
    assert.equal(edge.provenance.provenanceId, admitted.data.derivedFacts[0].derivationId);
  } finally {
    kernel.graph.close();
  }
});

test('kernel.prove returns the bounded prover verdict verbatim', () => {
  const kernel = newKernel();
  try {
    const proven = kernel.prove({
      rules: [affectsRule()],
      facts: compactFacts(),
      query: { predicate: 'affects', from: 'smoking', to: 'disease' },
    }, { limits: { timeoutMs: 5000 } });
    assert.equal(proven.ok, true);
    assert.equal(proven.data.status, 'proven');
    assert.equal(proven.data.proof.kind, 'rule');

    const notProven = kernel.prove({
      rules: [affectsRule()],
      facts: compactFacts(),
      query: { predicate: 'affects', from: 'smoking', to: 'bananas' },
    }, { limits: { timeoutMs: 5000 } });
    assert.equal(notProven.data.status, 'not_proven');

    const invalid = kernel.prove({ rules: [], facts: [], query: {} });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error.code, 'INVALID_INPUT');
  } finally {
    kernel.graph.close();
  }
});

test('the MCP surface reaches the inference runtime and stays read-only', async () => {
  const kernel = newKernel();
  try {
    const rules = [{
      id: 'rule:affects-through-type',
      head: { predicate: 'affects', args: [{ kind: 'variable', name: 'X' }, { kind: 'variable', name: 'Z' }] },
      body: [
        { predicate: 'CAUSES', args: [{ kind: 'variable', name: 'X' }, { kind: 'variable', name: 'Y' }] },
        { predicate: 'is_a', args: [{ kind: 'variable', name: 'Y' }, { kind: 'variable', name: 'Z' }] },
      ],
    }];

    const deriveResult = await callTool(kernel, {
      name: 'huqan.derive',
      arguments: { rules, facts: compactFacts(), workspaceId: 'default', limits: { timeoutMs: 5000 } },
    });
    assert.equal(deriveResult.ok, true);
    assert.equal(deriveResult.workflowId, 'derive');
    assert.equal(deriveResult.data.derivedFacts[0].fact.predicate, 'affects');
    assert.equal(deriveResult.data.derivedFacts[0].state, 'provisional');
    assert.equal(
      kernel.graph.getEdges('smoking', 'default').some((edge) => edge.relation === 'affects'),
      false,
      'the MCP derive tool must not write to canonical memory',
    );

    const proveResult = await callTool(kernel, {
      name: 'huqan.prove',
      arguments: {
        rules,
        facts: compactFacts(),
        query: { predicate: 'affects', from: 'smoking', to: 'disease' },
        limits: { timeoutMs: 5000 },
      },
    });
    assert.equal(proveResult.ok, true);
    assert.equal(proveResult.workflowId, 'prove');
    assert.equal(proveResult.data.status, 'proven');
  } finally {
    kernel.graph.close();
  }
});

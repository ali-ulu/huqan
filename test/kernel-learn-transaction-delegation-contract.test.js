const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { runLearnTransaction } = require('../lib/kernel-learn-transaction');
const { ProvenanceError } = require('../lib/errors/provenance-error');

const kernelSource = fs.readFileSync(path.join(__dirname, '..', 'kernel.js'), 'utf8').replace(/\r\n/g, '\n');
const delegateSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'kernel-learn-transaction.js'), 'utf8').replace(/\r\n/g, '\n');

test('Kernel.learn is a one-line, cycle-free delegation (#2127)', () => {
  assert.match(
    kernelSource,
    /learn\(text, opts = \{\}\) \{\n    return runLearnTransaction\(\{ graph: this\.graph, kernel: this, enterCriticalSection: \(op\) => this\._enterCriticalSection\(op\), exitCriticalSection: \(\) => this\._exitCriticalSection\(\), appendAuditEvent: \(\.\.\.args\) => this\._appendAuditEvent\(\.\.\.args\), admit: \(k, t, o\) => admitLearn\(k, t, o\), runUseCase: \(k, t, o, d\) => runLearnUseCase\(k, t, o, d\), buildCanonicalReceipt: \(receipt, operationId, committedAt\) => buildLearnCanonicalReceipt\(receipt, operationId, committedAt\) \}, text, opts\);\n  \}/,
  );
  assert.doesNotMatch(delegateSource, /require\(['"].*kernel/);
  assert.doesNotMatch(delegateSource, /\bthis\./);
  assert.doesNotMatch(delegateSource, /kernel\._[A-Za-z]/, 'the kernel passthrough is opaque: only admit/runUseCase receive it');
  assert.doesNotMatch(delegateSource, /\._(nodes|edges|db|stmts)/);
  assert.deepEqual(Object.keys(require('../lib/kernel-learn-transaction')), ['runLearnTransaction']);
});

function harness(overrides = {}) {
  const sections = [];
  const runs = [];
  const calls = { audits: 0, admitted: 0, used: 0 };
  const graph = {
    runMutationOnce: (operationId, fn) => {
      const result = fn();
      runs.push(operationId);
      return { result, replayed: false, persisted: true, receipt: null };
    },
    save: () => { throw new Error('persisted path must not save'); },
  };
  const kernel = { marker: 'opaque-kernel' };
  const deps = {
    graph,
    kernel,
    enterCriticalSection: (op) => sections.push(['enter', op]),
    exitCriticalSection: () => sections.push(['exit']),
    appendAuditEvent: () => { calls.audits += 1; return { auditId: 'a1' }; },
    admit: (k, t, o) => {
      calls.admitted += 1;
      assert.equal(k, kernel);
      return { text: t, opts: o };
    },
    runUseCase: (k, t, o) => {
      calls.used += 1;
      assert.equal(k, kernel);
      return { ok: true, learned: 1 };
    },
    buildCanonicalReceipt: () => ({ unit: 'receipt-test' }),
    ...overrides,
  };
  return { deps, kernel, sections, runs, calls };
}

test('learn transaction admits, guards the critical section, and returns the result', () => {
  const { deps, sections, runs, calls } = harness();

  const result = runLearnTransaction(deps, 'kedi hayvandir', { workspaceId: 'default', mutationOperationId: 'op-1' });

  assert.deepEqual(sections, [['enter', 'learn'], ['exit']]);
  assert.deepEqual(runs, ['op-1']);
  assert.equal(calls.admitted, 1);
  assert.equal(calls.used, 1);
  assert.equal(calls.audits, 0);
  assert.equal(result.ok, true);
  assert.equal(result.meta.durableMutation, true);
  assert.equal(result.meta.replayed, false);
});

test('learn transaction exits the critical section when the journal is unavailable', () => {
  const { deps, sections } = harness({ graph: {} });
  assert.throws(
    () => runLearnTransaction(deps, 'kedi hayvandir', { workspaceId: 'default', mutationOperationId: 'op-2' }),
    /durable mutation journal is unavailable/,
  );
  assert.deepEqual(sections, [['enter', 'learn'], ['exit']]);
});

test('learn transaction re-appends the REJECT audit after a strict-provenance throw', () => {
  const { deps, sections, calls } = harness({
    runUseCase: () => { throw new ProvenanceError('no provenance'); },
  });
  assert.throws(
    () => runLearnTransaction(deps, 'kedi hayvandir', { workspaceId: 'default', mutationOperationId: 'op-3' }),
    /no provenance/,
  );
  assert.deepEqual(sections, [['enter', 'learn'], ['exit']]);
  assert.equal(calls.audits, 1);
});

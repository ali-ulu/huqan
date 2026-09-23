const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { runProposeNode } = require('../lib/kernel-propose-node');

const kernelSource = fs.readFileSync(path.join(__dirname, '..', 'kernel.js'), 'utf8').replace(/\r\n/g, '\n');
const delegateSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'kernel-propose-node.js'), 'utf8').replace(/\r\n/g, '\n');

test('Kernel.proposeNode is a one-line, cycle-free delegation (#2127)', () => {
  assert.match(
    kernelSource,
    /proposeNode\(id, label, provenance, opts = \{\}\) \{\n    return runProposeNode\(\{ graph: this\.graph, contractVersion: this\.contractVersion, trustPolicyPath: this\.trustPolicyPath, evaluateLearnAdmission: \(\.\.\.args\) => this\._evaluateLearnAdmission\(\.\.\.args\), appendAuditEvent: \(\.\.\.args\) => this\._appendAuditEvent\(\.\.\.args\), admissionReceiptDetails: admission => this\._admissionReceiptDetails\(admission\) \}, id, label, provenance, opts\);\n  \}/,
  );
  assert.doesNotMatch(delegateSource, /require\(['"].*kernel/);
  assert.doesNotMatch(delegateSource, /\bthis\./);
  assert.doesNotMatch(delegateSource, /\._(nodes|edges|db|stmts)/);
  assert.deepEqual(Object.keys(require('../lib/kernel-propose-node')), ['runProposeNode']);
});

function collaborators(overrides = {}) {
  const calls = { audits: [] };
  const graph = {
    addNode: (id, label, provenance, opts) => ({ id, label, provenance, opts }),
  };
  return {
    calls,
    deps: {
      graph,
      contractVersion: '1.0.0-test',
      trustPolicyPath: '/tmp/trust-test',
      evaluateLearnAdmission: overrides.evaluateLearnAdmission || (() => ({ outcome: 'allow', reason: 'test' })),
      appendAuditEvent: (event, provenance, workspaceId) => {
        calls.audits.push({ event, provenance, workspaceId });
        return { auditId: 'a1' };
      },
      admissionReceiptDetails: () => ({ receipt: 'r1' }),
    },
  };
}

test('proposeNode reviews without a graph', () => {
  const { deps } = collaborators();
  const result = runProposeNode({ ...deps, graph: null }, 'n', 'label', null, {});
  assert.deepEqual(result, { decision: 'review', node: null, audit: null, admission: null });
});

test('proposeNode audits REVIEW when admission is unavailable', () => {
  const { deps, calls } = collaborators({ evaluateLearnAdmission: () => null });
  const result = runProposeNode(deps, 'n1', 'label', null, { workspaceId: 'default' });
  assert.equal(result.decision, 'review');
  assert.equal(result.node, null);
  assert.equal(result.admission, null);
  assert.equal(calls.audits.length, 1);
  assert.equal(calls.audits[0].event.eventType, 'REVIEW');
  assert.equal(calls.audits[0].event.details.reason, 'admission_unavailable');
});

test('proposeNode rejects without writing when admission refuses', () => {
  const { deps, calls } = collaborators({
    evaluateLearnAdmission: () => ({ outcome: 'reject', reason: 'policy', approvalStatus: 'denied' }),
  });
  const result = runProposeNode(deps, 'n2', 'label', null, { workspaceId: 'default' });
  assert.equal(result.decision, 'reject');
  assert.equal(result.node, null);
  assert.equal(calls.audits.length, 1);
  assert.equal(calls.audits[0].event.eventType, 'REJECT');
  assert.equal(calls.audits[0].event.details.admissionOutcome, 'reject');
});

test('proposeNode writes and audits LEARN when admission allows', () => {
  const { deps, calls } = collaborators();
  const result = runProposeNode(deps, 'n3', 'label', { provenanceId: 'p1', actor: 'plugin' }, { workspaceId: 'default' });
  assert.equal(result.decision, 'allow');
  assert.equal(result.node.id, 'n3');
  assert.equal(result.admission.outcome, 'allow');
  assert.equal(calls.audits.length, 1);
  assert.equal(calls.audits[0].event.eventType, 'LEARN');
  assert.equal(calls.audits[0].event.details.admissionOutcome, 'allow');
  assert.equal(calls.audits[0].workspaceId, 'default');
});

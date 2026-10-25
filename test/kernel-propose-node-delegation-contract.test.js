const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { runProposeNode } = require('../lib/kernel-propose-node');
const { admissionRiskFromConfidence } = require('../lib/background-provenance');

const REAL_POLICY_PATH = path.join(__dirname, '..', 'config', 'trust-policy.default.json');

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

/**
 * Builds a fake collaborator set for the delegation-contract tests.
 *
 * @param {object} [overrides] - Optional per-test overrides.
 * @param {string} [overrides.trustPolicyPath] - Path to the trust-policy JSON.
 * @param {Function} [overrides.evaluateLearnAdmission] - Admission-gate stub.
 * @returns {{ deps: object, calls: object }} The fake deps plus a recorder.
 */
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
      trustPolicyPath: overrides.trustPolicyPath || REAL_POLICY_PATH,
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

// #4251: a caller-supplied provenance used to skip trust-policy scoring, so a
// plugin that declared its own confidence sailed through with an admission
// risk of zero. The policy now scores both branches; a low-trust sourceType
// (llm, 0.4) maps to a medium risk and earns review instead of allow.
test('proposeNode scores caller-supplied provenance through the trust policy (#4251)', (t) => {
  const { deps, calls } = collaborators({
    evaluateLearnAdmission: (text, admissionOpts, provenance, workspaceId) => {
      const risk = admissionRiskFromConfidence(provenance?.confidence);
      return risk >= 50
        ? { outcome: 'review', reason: 'medium_risk_memory_write', approvalStatus: 'not_required' }
        : { outcome: 'allow', reason: 'provenance_present_low_risk' };
    },
  });
  const addNode = t.mock.method(deps.graph, 'addNode');
  const lowTrust = runProposeNode(deps, 'n4', 'label', {
    provenanceId: 'p4', actor: 'plugin', sourceType: 'llm', confidence: 1,
  }, { workspaceId: 'default' });
  assert.equal(lowTrust.decision, 'review');
  assert.equal(lowTrust.node, null);
  assert.equal(lowTrust.admission.outcome, 'review');
  assert.equal(addNode.mock.callCount(), 0);
  // The policy score reached the provenance that the admission gate read.
  assert.equal(calls.audits[0].provenance.confidence, 0.4);
  assert.equal(calls.audits[0].provenance.declaredConfidence, 1);
  assert.equal(calls.audits[0].provenance.confidenceSource, 'policy_default');

  const scored = runProposeNode(deps, 'n5', 'label', {
    provenanceId: 'p5', actor: 'plugin', sourceType: 'document',
  }, { workspaceId: 'default' });
  assert.equal(scored.decision, 'allow');
  assert.equal(scored.node.id, 'n5');
  assert.equal(scored.admission.outcome, 'allow');
});

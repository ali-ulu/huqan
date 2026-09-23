'use strict';

/**
 * The measured claims in `docs/task-packs/p1g-pre-site-source-reality.md`.
 *
 * ADR-012 step 1 is "the five pre sites -> fail closed". This measurement found
 * they already are: every one of them is a refusal-recording branch, so the
 * mutation was decided against before the audit is attempted, and the refusal
 * is carried by the return value rather than by the audit write.
 *
 * That is a claim about behaviour under failure, so it is tested by inducing
 * the failure -- the audit sink is replaced with one that throws -- rather than
 * by reading the code. The reading is what produced the wrong "fail-open" label
 * in ADR-012 in the first place.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Kernel = require('../kernel.js');

const REPO_ROOT = path.join(__dirname, '..');
const PROVENANCE = Object.freeze({
  provenanceId: 'p1', actor: 'plugin', sourceType: 'plugin', sourceRef: 'r', workspaceId: 'default',
});

/** A kernel whose audit sink is down and whose admission is forced. */
function kernelWithDeadAudit(admissionOutcome) {
  const kernel = new Kernel({});
  kernel.graph.appendAuditEvent = () => { throw new Error('audit sink down'); };
  kernel._evaluateLearnAdmission = () => admissionOutcome;
  return kernel;
}

const ADMISSION_UNAVAILABLE = null;
const ADMISSION_REJECTS = Object.freeze({ outcome: 'reject', reason: 'test_refusal', approvalStatus: 'rejected' });

test('site 1: admission unavailable — refusal survives a dead audit sink', () => {
  const kernel = kernelWithDeadAudit(ADMISSION_UNAVAILABLE);

  const result = kernel.proposeNode('n1', 'label', PROVENANCE, { workspaceId: 'default' });

  // Enforcement: nothing got through.
  assert.equal(result.node, null);
  assert.ok(!kernel.graph.getNode('n1', 'default'), 'the node must be absent from the graph');
  // Visibility of the refusal: carried by the return value, not the audit.
  assert.equal(result.decision, 'review');
  // Evidence: absent, and observably so.
  assert.equal(result.audit, null);
});

test('site 2: admission refuses — refusal survives a dead audit sink', () => {
  const kernel = kernelWithDeadAudit(ADMISSION_REJECTS);

  const result = kernel.proposeNode('n1', 'label', PROVENANCE, { workspaceId: 'default' });

  assert.equal(result.node, null);
  assert.ok(!kernel.graph.getNode('n1', 'default'), 'the node must be absent from the graph');
  assert.equal(result.decision, 'reject');
  assert.equal(result.audit, null);
});

test('sites 3 and 4: the edge path behaves identically', () => {
  for (const [admission, expected] of [[ADMISSION_UNAVAILABLE, 'review'], [ADMISSION_REJECTS, 'reject']]) {
    const kernel = kernelWithDeadAudit(admission);

    const result = kernel.proposeEdge('a', 'b', 'rel', { workspaceId: 'default' });

    assert.equal(result.edge, null);
    assert.equal(result.decision, expected);
    assert.equal(result.audit, null);
  }
});

test('the refusal is caused by admission, not by the audit failure', () => {
  // Without this contrast the tests above would also pass if a dead audit sink
  // were what blocked the write -- which would be a different (and worse)
  // system than the one being described.
  const kernel = new Kernel({});
  kernel.graph.appendAuditEvent = () => { throw new Error('audit sink down'); };

  const result = kernel.proposeNode('n2', 'label', PROVENANCE, { workspaceId: 'default' });

  assert.equal(result.decision, 'allow');
  assert.ok(result.node, 'an admitted write still happens with a dead audit sink');
  // ...and this is the post-mutation position, where ADR-012 forbids exactly
  // this: the write landed and its evidence vanished without a sound.
  assert.equal(result.audit, null);
});

test('site 5: the rejection propagates regardless of the audit — from source', () => {
  // Not executed. Reaching this branch through the public `learn` surface was
  // attempted and did not trigger, so no execution evidence is claimed; the
  // conclusion is structural and is asserted as such.
  const source = fs.readFileSync(path.join(REPO_ROOT, 'kernel.js'), 'utf8');

  // _appendAuditEvent cannot throw: it catches internally and returns null.
  assert.match(source, /_appendAuditEvent\([\s\S]{0,400}?catch \(error\) \{[\s\S]{0,120}?return null;/);
  // ...and the rejection is rethrown unconditionally after it.
  assert.match(
    source,
    /PROVENANCE_REQUIRED'\) \{\s*this\._appendAuditEvent\(\{[\s\S]{0,700}?\}\s*throw error;/,
    'the rethrow must not be conditional on the audit write',
  );
});

test('the evidence signal is already consumed by a production caller', () => {
  // ADR-012 step 1 was constrained to invent no new error contract. It does not
  // need to: `audit` is already in the return shape and already read.
  // #2127: the read moved with the _crossLink body to lib/kernel-cross-link.js.
  const crossLink = fs.readFileSync(path.join(REPO_ROOT, 'lib', 'kernel-cross-link.js'), 'utf8');

  assert.match(crossLink, /if \(result\.audit\) audits\+\+;/);
  const source = fs.readFileSync(path.join(REPO_ROOT, 'kernel.js'), 'utf8');

  assert.match(source, /return runCrossLink\(\{ graph: this\.graph,/);
  assert.match(source, /return runProposeNode\(\{ graph: this\.graph,/);
  // #2127 dilim 2: the proposeNode reject return moved with its body to
  // lib/kernel-propose-node.js; the evidence shape is pinned there.
  const proposeNode = fs.readFileSync(path.join(REPO_ROOT, 'lib', 'kernel-propose-node.js'), 'utf8');

  assert.match(proposeNode, /return \{ decision: admission\.outcome, node: null, audit, admission \};/);
});

test('conflict detection no longer reaches the private Kernel audit chokepoint (#2166)', () => {
  const count = (relPath) => {
    const source = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    return (source.match(/_appendAuditEvent\s*\(/g) || []).length;
  };

  // The legacy Kernel/learn paths still use the compatibility chokepoint.
  // #2127: proposeNode's three chokepoint calls moved with its body to
  // lib/kernel-propose-node.js behind the injected alias (K2 shape), and the
  // facade arrow repays one; cross-link did the same in dilim 1. Count is the
  // method definition plus two facade arrows plus two direct calls.
  assert.equal(count('kernel.js'), 5, 'facades plus direct calls plus the method definition, cross-link and proposeNode delegated');
  assert.equal(count('lib/learn-use-case.js'), 7);
  // #2166 moves conflict detection to Graph.appendAuditEvent instead.
  assert.equal(count('lib/conflict-detector.js'), 0);

  const { NOT_YET_WIRED } = require('../lib/module-reachability.js');
  assert.equal(Object.prototype.hasOwnProperty.call(NOT_YET_WIRED, 'lib/github-connector.js'), false);
});

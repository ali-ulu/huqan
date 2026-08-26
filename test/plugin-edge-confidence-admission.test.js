'use strict';
const { isolatedKernelOptions, isolatedGraphOptions } = require('./helpers/isolated-persistence');

/**
 * #697: the trust policy's confidence has to change the admission decision.
 *
 * It did not. The policy scored every background and plugin write -- `llm` at
 * 0.4, `github` at 0.75 -- wrote the number into provenance, and then built an
 * admission request with a hardcoded riskScore of 0. All eight source types
 * reached the same `allow` / `provenance_present_low_risk`, and the canonical
 * edge was written for each. The confidence was accurate metadata attached to
 * a decision it never touched.
 *
 * The gate itself was never broken: 85 and above quarantines, 50 and above
 * reviews. Nothing was putting a number in front of it.
 *
 * These tests assert the property rather than the plumbing. Asserting that
 * provenance carries a confidence is what let the gap survive; what has to
 * hold is that the decision moves when the confidence does.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const Kernel = require('../kernel');
const {
  UNCLASSIFIED_SOURCE_CONFIDENCE,
  admissionRiskFromConfidence,
} = require('../lib/background-provenance');
const { buildLearnAdmissionRequest } = require('../lib/learn-admission-request');

function kernelWithNodes() {
  const kernel = new Kernel(isolatedKernelOptions('plugin-edge-confidence-admission', { noLoad: true, loadPlugins: false, useSQLite: false }));
  kernel.proposeNode('from', 'From', null, {});
  kernel.proposeNode('to', 'To', null, {});
  return kernel;
}

function proposeFrom(kernel, sourceType, relation = `rel_${sourceType}`) {
  return kernel.proposeEdge('from', 'to', relation, {
    sourceType,
    sourceRef: `test:${sourceType}`,
    sessionId: 'untrusted-plugin',
  });
}

test('a source the policy rates below an unclassified one does not write canonically (#697)', () => {
  const kernel = kernelWithNodes();

  const result = proposeFrom(kernel, 'llm');

  assert.equal(result.decision, 'review');
  assert.equal(result.admission.reason, 'medium_risk_memory_write');
  assert.equal(result.edge, null, 'a reviewed proposal must not reach the canonical graph');
});

test('sources at or above the unclassified confidence keep writing as before (#697)', () => {
  const kernel = kernelWithNodes();

  // The narrow reading of the fix, and the reason it is narrow: `plugin` is
  // proposeEdge's own default source type. Scoring it as risk would put every
  // default plugin write into review, which is a change to how the product
  // runs rather than a fix to what #697 found.
  for (const sourceType of ['plugin', 'unknown', 'human', 'file', 'api', 'manual', 'github']) {
    const result = proposeFrom(kernel, sourceType);
    assert.equal(result.decision, 'allow', `${sourceType} should still be admitted`);
    assert.equal(result.admission.reason, 'provenance_present_low_risk');
    assert.ok(result.edge, `${sourceType} should still write its edge`);
    assert.ok(
      result.edge.provenance.confidence >= UNCLASSIFIED_SOURCE_CONFIDENCE,
      `${sourceType} is only expected to pass because the policy rates it >= ${UNCLASSIFIED_SOURCE_CONFIDENCE}`,
    );
  }
});

test('the decision follows the confidence, not merely the presence of provenance (#697)', () => {
  const kernel = kernelWithNodes();

  const low = proposeFrom(kernel, 'llm', 'rel_low');
  const high = proposeFrom(kernel, 'github', 'rel_high');

  // Both carry provenance, both are scored by the same policy, and they differ
  // only in the confidence that policy assigned. That difference has to be
  // visible in the outcome -- which is the whole of #697.
  assert.ok(low.edge === null && high.edge !== null);
  assert.notEqual(low.decision, high.decision);
  assert.ok(
    low.admission.provenanceId && high.admission.provenanceId,
    'provenance is present on both, so provenance presence cannot be what separates them',
  );
});

test('an explicitly approved write is not sent back for review by a derived score (#697)', () => {
  const kernel = new Kernel({ noLoad: true });

  // The gate applies medium risk after approval handling and overrides `allow`
  // there. Deriving a score from the source someone had just approved the
  // write for would revoke their approval on its own authority.
  const result = kernel.learnFromLLM('Kedi bir memelidir. Kediler balık yer.', {
    approvalRequired: true,
    approvalStatus: 'approved',
    approvalId: 'apr_697_test',
    sourceType: 'llm',
    sourceRef: 'test:approved-llm',
    actor: 'llm-test',
    workspaceId: 'default',
  });

  assert.ok(result.learned > 0, 'an approved LLM write must still be admitted');
});

test('a caller-supplied risk score is never lowered by the derived one (#697)', () => {
  // Asserted against the request builder rather than proposeEdge, because
  // proposeEdge forwards no admission context of its own today: the plugin
  // surface has no way to declare a risk. The maximum exists so that the paths
  // which do carry one -- and any that gain one later -- cannot have it
  // quietly replaced by a policy score that happens to be lower.
  const derivedOnly = buildLearnAdmissionRequest({
    text: 'x',
    opts: {},
    provenance: { provenanceId: 'p', confidence: 0.4 },
    workspaceId: 'default',
    contractVersion: '1.0.0',
  });
  assert.equal(derivedOnly.riskScore, 60);

  const callerHigher = buildLearnAdmissionRequest({
    text: 'x',
    opts: { riskScore: 90 },
    provenance: { provenanceId: 'p', confidence: 0.75 },
    workspaceId: 'default',
    contractVersion: '1.0.0',
  });
  assert.equal(callerHigher.riskScore, 90, 'github derives nothing; the caller\'s 90 stands');

  const callerLower = buildLearnAdmissionRequest({
    text: 'x',
    opts: { riskScore: 10 },
    provenance: { provenanceId: 'p', confidence: 0.4 },
    workspaceId: 'default',
    contractVersion: '1.0.0',
  });
  assert.equal(callerLower.riskScore, 60, 'the derived score wins when it is the higher of the two');
});

test('the confidence-to-risk mapping is one stated rule, including its edges (#697)', () => {
  assert.equal(admissionRiskFromConfidence(UNCLASSIFIED_SOURCE_CONFIDENCE), 0, 'the floor itself passes');
  assert.equal(admissionRiskFromConfidence(0.75), 0);
  assert.equal(admissionRiskFromConfidence(1), 0);

  assert.equal(admissionRiskFromConfidence(0.4), 60, 'below the floor, review');
  assert.equal(admissionRiskFromConfidence(0.1), 90, 'far below it, quarantine — the ladder, not a second rule');
  assert.equal(admissionRiskFromConfidence(0), 100);

  // An unscored write is not an incriminated one: the guarded fallback in
  // buildBackgroundProvenance exists so a malformed policy file cannot turn a
  // background write into a throw, and it must not become a refusal either.
  for (const absent of [undefined, null, Number.NaN, 'high', {}]) {
    assert.equal(admissionRiskFromConfidence(absent), 0);
  }
  assert.equal(admissionRiskFromConfidence(-1), 100, 'a nonsense negative still clamps inside the scale');
});

'use strict';

/**
 * Experience Core E3 — ExperienceVerifier tests (#2389).
 *
 * Pure admission and eligibility rules for `lib/experience/verifier.js`.
 * Hermetic: no I/O, no storage, no timers, no journal.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  VERIFIER_KINDS,
  checkIndependence,
  validateAssessment,
  assessOutcome,
} = require('../lib/experience/verifier');

function fullProofs(overrides = {}) {
  return {
    integrity: true, coverage: true, verification: true, provenance: true, permission: true,
    ...overrides,
  };
}

function assessment(overrides = {}) {
  return {
    verifier: { name: 'file-exists-check', version: '1.0.0' },
    kind: VERIFIER_KINDS.OBSERVATIONAL,
    verdict: 'verified',
    proofs: fullProofs(),
    evidence: { path: '/data/out.json', observed: true },
    scope: { runId: 'run-1' },
    executor: { tool: 'write-file', adapter: 'local-fs', credentials: 'agent-token' },
    channel: { tool: 'stat', adapter: 'local-fs-probe', credentials: 'verifier-token' },
    ...overrides,
  };
}

describe('E3: executor success never verifies by itself', () => {
  it('no assessment means unknown and ineligible', () => {
    const res = assessOutcome({ executionStatus: 'completed' });
    assert.equal(res.ok, true);
    assert.equal(res.outcomeStatus, 'unknown');
    assert.equal(res.learningEligibility, 'ineligible');
    assert.equal(res.record, null);
  });

  it('a `none` kind honestly reports unknown', () => {
    const res = assessOutcome({
      executionStatus: 'completed',
      assessments: [assessment({ kind: VERIFIER_KINDS.NONE, verdict: 'unknown', proofs: {} })],
    });
    assert.equal(res.outcomeStatus, 'unknown');
    assert.equal(res.learningEligibility, 'ineligible');
  });
});

describe('E3: positive acceptance needs all five proofs', () => {
  it('full proofs with independence verify', () => {
    const res = assessOutcome({ executionStatus: 'completed', assessments: [assessment()] });
    assert.equal(res.ok, true);
    assert.equal(res.outcomeStatus, 'verified');
    assert.equal(res.learningEligibility, 'positive_procedure');
  });

  for (const missing of ['integrity', 'coverage', 'verification', 'provenance', 'permission']) {
    it(`missing ${missing} degrades to unknown, never positive`, () => {
      const res = assessOutcome({
        executionStatus: 'completed',
        assessments: [assessment({ proofs: fullProofs({ [missing]: false }) })],
      });
      assert.equal(res.outcomeStatus, 'unknown');
      assert.notEqual(res.learningEligibility, 'positive_procedure');
    });
  }

  it('a deleted test (lost coverage) is unknown, not verified', () => {
    const res = assessOutcome({
      executionStatus: 'completed',
      assessments: [assessment({ proofs: fullProofs({ coverage: false }) })],
    });
    assert.equal(res.outcomeStatus, 'unknown');
    assert.equal(res.learningEligibility, 'ineligible');
  });
});

describe('E3: tampering and disagreement never verify', () => {
  it('tampered integrity is unknown', () => {
    const res = assessOutcome({
      executionStatus: 'completed',
      assessments: [assessment({ proofs: fullProofs({ integrity: false }) })],
    });
    assert.equal(res.outcomeStatus, 'unknown');
    assert.notEqual(res.learningEligibility, 'positive_procedure');
  });

  it('disagreeing verifiers need review', () => {
    const res = assessOutcome({
      executionStatus: 'completed',
      assessments: [
        assessment(),
        assessment({
          verifier: { name: 'second-opinion', version: '2.0.0' },
          kind: VERIFIER_KINDS.DIFFERENTIAL,
          verdict: 'failed',
          proofs: {},
        }),
      ],
    });
    assert.equal(res.ok, true);
    assert.equal(res.outcomeStatus, 'unknown');
    assert.equal(res.learningEligibility, 'needs_review');
  });
});

describe('E3: independence is checkable', () => {
  it('same tool, adapter and credentials share a failure mode', () => {
    assert.deepEqual(checkIndependence(assessment({
      channel: { tool: 'write-file', adapter: 'local-fs', credentials: 'agent-token' },
    })), { ok: false, code: 'shared_failure_mode' });
    const res = assessOutcome({
      executionStatus: 'completed',
      assessments: [assessment({
        channel: { tool: 'write-file', adapter: 'local-fs', credentials: 'agent-token' },
      })],
    });
    assert.equal(res.outcomeStatus, 'unknown');
    assert.notEqual(res.learningEligibility, 'positive_procedure');
  });

  it('one differing dimension is enough', () => {
    assert.deepEqual(checkIndependence(assessment({
      channel: { tool: 'write-file', adapter: 'local-fs', credentials: 'verifier-token' },
    })), { ok: true });
  });

  it('missing channel information is uncheckable, not independent', () => {
    assert.deepEqual(checkIndependence({ executor: {}, channel: {} }),
      { ok: false, code: 'independence_uncheckable' });
  });
});

describe('E3: swap counterexamples are refused, not judged', () => {
  it('unknown verifier kind is refused', () => {
    assert.deepEqual(validateAssessment(assessment({ kind: 'vibes' })),
      { ok: false, code: 'unknown_verifier_kind' });
    assert.deepEqual(assessOutcome({ assessments: [assessment({ kind: 'vibes' })] }),
      { ok: false, code: 'unknown_verifier_kind' });
  });

  it('missing verifier identity is refused', () => {
    assert.deepEqual(validateAssessment(assessment({ verifier: { name: '', version: '' } })),
      { ok: false, code: 'invalid_verifier_identity' });
  });
});

describe('E3: failure evidence and LLM labelling', () => {
  it('failed runs with permitted failure evidence are negative examples', () => {
    const res = assessOutcome({
      executionStatus: 'failed',
      assessments: [assessment({
        kind: VERIFIER_KINDS.DIFFERENTIAL,
        verdict: 'failed',
        proofs: { failureEvidence: true, permission: true },
      })],
    });
    assert.equal(res.outcomeStatus, 'failed');
    assert.equal(res.learningEligibility, 'negative_example');
  });

  it('transitive LLM use is labelled and changes nothing', () => {
    const res = assessOutcome({
      executionStatus: 'completed',
      assessments: [assessment({ llmInvolved: true })],
    });
    assert.equal(res.outcomeStatus, 'verified');
    assert.equal(res.record.llmInvolved, true);
    const plain = assessOutcome({
      executionStatus: 'completed',
      assessments: [assessment({ llmInvolved: false })],
    });
    assert.equal(plain.record.llmInvolved, false);
    assert.equal(plain.outcomeStatus, res.outcomeStatus);
  });

  it('the record carries identity, scope and evidence for the journal', () => {
    const res = assessOutcome({ executionStatus: 'completed', assessments: [assessment()] });
    assert.deepEqual(res.record.verifier, { name: 'file-exists-check', version: '1.0.0' });
    assert.equal(res.record.kind, VERIFIER_KINDS.OBSERVATIONAL);
    assert.deepEqual(res.record.scope, { runId: 'run-1' });
    assert.deepEqual(res.record.evidence, { path: '/data/out.json', observed: true });
  });
});

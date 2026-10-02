'use strict';

/**
 * Capability Trust ladder tests (#2394, design #2383).
 *
 * Hermetic: no I/O, no storage, no timers. Implements the 8 acceptance
 * tests listed at the end of #2383's design comment, in order.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  TRUST_STATES,
  MIN_EXECUTIONS_FOR_TRUST,
  MIN_TRUSTED_EXECUTIONS,
  DEMOTION_NEGATIVE_THRESHOLD,
  createCapabilityTrustRegistry,
} = require('../lib/experience/capability-trust');

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const MIN = 60 * 1000;

function recordN(registry, { workspaceId, capabilityId, procedureVersion, count, eligibility, startAt = T0 }) {
  let last;
  for (let i = 0; i < count; i += 1) {
    last = registry.recordRun({
      workspaceId,
      capabilityId,
      procedureVersion,
      eventId: `${capabilityId}-${eligibility}-${i}`,
      runId: `run-${capabilityId}-${eligibility}-${i}`,
      learningEligibility: eligibility,
      occurredAt: startAt + i * MIN,
    });
  }
  return last;
}

describe('Capability Trust: acceptance tests (#2383)', () => {
  it('1. fewer than MIN_EXECUTIONS_FOR_TRUST runs -> insufficient-data, never a number', () => {
    const registry = createCapabilityTrustRegistry();
    const res = recordN(registry, {
      workspaceId: 'ws-a', capabilityId: 'cap-1', procedureVersion: 'v1',
      count: MIN_EXECUTIONS_FOR_TRUST - 1, eligibility: 'positive_procedure',
    });
    assert.equal(res.entry.trustState, TRUST_STATES.INSUFFICIENT_DATA);
    assert.equal(res.entry.evidenceWindow.positiveCount, MIN_EXECUTIONS_FOR_TRUST - 1);
  });

  it('2. 25 positive_procedure runs, 0 negatives -> trusted', () => {
    const registry = createCapabilityTrustRegistry();
    const res = recordN(registry, {
      workspaceId: 'ws-a', capabilityId: 'cap-2', procedureVersion: 'v1',
      count: MIN_TRUSTED_EXECUTIONS, eligibility: 'positive_procedure',
    });
    assert.equal(res.entry.trustState, TRUST_STATES.TRUSTED);
    assert.equal(res.entry.evidenceWindow.negativeCount, 0);
  });

  it('3. trusted capability gets one negative_example -> probationary, no lag', () => {
    const registry = createCapabilityTrustRegistry();
    recordN(registry, {
      workspaceId: 'ws-a', capabilityId: 'cap-3', procedureVersion: 'v1',
      count: MIN_TRUSTED_EXECUTIONS, eligibility: 'positive_procedure',
    });
    assert.equal(registry.get('ws-a', 'cap-3').trustState, TRUST_STATES.TRUSTED);
    const res = registry.recordRun({
      workspaceId: 'ws-a', capabilityId: 'cap-3', procedureVersion: 'v1',
      eventId: 'cap-3-neg-0', runId: 'run-cap-3-neg-0',
      learningEligibility: 'negative_example', occurredAt: T0 + 1000 * MIN,
    });
    assert.equal(res.entry.trustState, TRUST_STATES.PROBATIONARY);
    const last = res.entry.history[res.entry.history.length - 1];
    assert.equal(last.fromState, TRUST_STATES.TRUSTED);
    assert.equal(last.toState, TRUST_STATES.PROBATIONARY);
  });

  it('4. 3 negatives in trailing window from probationary -> demoted', () => {
    const registry = createCapabilityTrustRegistry();
    // Enough runs to leave insufficient-data, not enough positives to trust.
    recordN(registry, {
      workspaceId: 'ws-a', capabilityId: 'cap-4', procedureVersion: 'v1',
      count: MIN_EXECUTIONS_FOR_TRUST, eligibility: 'positive_procedure',
    });
    assert.equal(registry.get('ws-a', 'cap-4').trustState, TRUST_STATES.PROBATIONARY);
    let res;
    for (let i = 0; i < DEMOTION_NEGATIVE_THRESHOLD; i += 1) {
      res = registry.recordRun({
        workspaceId: 'ws-a', capabilityId: 'cap-4', procedureVersion: 'v1',
        eventId: `cap-4-neg-${i}`, runId: `run-cap-4-neg-${i}`,
        learningEligibility: 'negative_example', occurredAt: T0 + (1000 + i) * MIN,
      });
    }
    assert.equal(res.entry.trustState, TRUST_STATES.DEMOTED);
  });

  it('5. procedure rebind while trusted -> probationary, old evidence retained and version-labeled', () => {
    const registry = createCapabilityTrustRegistry();
    recordN(registry, {
      workspaceId: 'ws-a', capabilityId: 'cap-5', procedureVersion: 'v1',
      count: MIN_TRUSTED_EXECUTIONS, eligibility: 'positive_procedure',
    });
    assert.equal(registry.get('ws-a', 'cap-5').trustState, TRUST_STATES.TRUSTED);
    const res = registry.rebindProcedure({
      workspaceId: 'ws-a', capabilityId: 'cap-5', newProcedureVersion: 'v2', atEventId: 'rebind-1',
    });
    assert.equal(res.entry.trustState, TRUST_STATES.PROBATIONARY);
    assert.equal(res.entry.boundProcedureVersion, 'v2');
    // Old evidence stays in history as a transition record; the window is
    // now scoped to v2, which has zero events -- and it isn't
    // insufficient-data because the rebind floor overrides that reading.
    assert.equal(res.entry.evidenceWindow.procedureVersion, 'v2');
    assert.equal(res.entry.evidenceWindow.totalCount, 0);
    const rebindEntry = res.entry.history.find((h) => h.reason === 'procedure_rebind');
    assert.ok(rebindEntry);
    assert.equal(rebindEntry.fromState, TRUST_STATES.TRUSTED);
    assert.equal(rebindEntry.toState, TRUST_STATES.PROBATIONARY);
  });

  it('6. cross-workspace read of the same capabilityId -> insufficient-data, no leakage', () => {
    const registry = createCapabilityTrustRegistry();
    recordN(registry, {
      workspaceId: 'ws-trusted', capabilityId: 'cap-shared', procedureVersion: 'v1',
      count: MIN_TRUSTED_EXECUTIONS, eligibility: 'positive_procedure',
    });
    assert.equal(registry.get('ws-trusted', 'cap-shared').trustState, TRUST_STATES.TRUSTED);
    assert.equal(registry.get('ws-other', 'cap-shared').trustState, TRUST_STATES.INSUFFICIENT_DATA);
  });

  it('7. composition starts at insufficient-data on creation, not trusted', () => {
    const registry = createCapabilityTrustRegistry();
    recordN(registry, {
      workspaceId: 'ws-a', capabilityId: 'cap-part-1', procedureVersion: 'v1',
      count: MIN_TRUSTED_EXECUTIONS, eligibility: 'positive_procedure',
    });
    recordN(registry, {
      workspaceId: 'ws-a', capabilityId: 'cap-part-2', procedureVersion: 'v1',
      count: MIN_TRUSTED_EXECUTIONS, eligibility: 'positive_procedure',
    });
    assert.equal(registry.get('ws-a', 'cap-part-1').trustState, TRUST_STATES.TRUSTED);
    assert.equal(registry.get('ws-a', 'cap-part-2').trustState, TRUST_STATES.TRUSTED);
    const composed = registry.createCapability({
      workspaceId: 'ws-a', capabilityId: 'cap-composed', boundProcedureVersion: 'v1',
      composedFrom: ['cap-part-1', 'cap-part-2'],
    });
    assert.equal(composed.entry.trustState, TRUST_STATES.INSUFFICIENT_DATA);
  });

  it('8. operator/policy block -> demoted, operator identity + reason recorded, immune to auto-promotion', () => {
    const registry = createCapabilityTrustRegistry();
    recordN(registry, {
      workspaceId: 'ws-a', capabilityId: 'cap-8', procedureVersion: 'v1',
      count: MIN_TRUSTED_EXECUTIONS, eligibility: 'positive_procedure',
    });
    assert.equal(registry.get('ws-a', 'cap-8').trustState, TRUST_STATES.TRUSTED);
    const blocked = registry.applyOperatorBlock({
      workspaceId: 'ws-a', capabilityId: 'cap-8', operatorId: 'op-42', reason: 'suspected data exfiltration',
    });
    assert.equal(blocked.entry.trustState, TRUST_STATES.DEMOTED);
    const blockEntry = blocked.entry.history[blocked.entry.history.length - 1];
    assert.match(blockEntry.reason, /operator_block/);
    // Further positive evidence does not auto-promote while blocked.
    const res = recordN(registry, {
      workspaceId: 'ws-a', capabilityId: 'cap-8', procedureVersion: 'v1',
      count: MIN_TRUSTED_EXECUTIONS, eligibility: 'positive_procedure', startAt: T0 + 10000 * MIN,
    });
    assert.equal(res.entry.trustState, TRUST_STATES.DEMOTED);
    // Manually cleared: leaves demoted, but does not silently re-trust.
    const cleared = registry.clearOperatorBlock({
      workspaceId: 'ws-a', capabilityId: 'cap-8', operatorId: 'op-42', reason: 'reviewed, false positive',
    });
    assert.notEqual(cleared.entry.trustState, TRUST_STATES.DEMOTED);
  });
});

describe('Capability Trust: supporting behavior', () => {
  it('insufficient-data never returns a numeric score', () => {
    const registry = createCapabilityTrustRegistry();
    const res = registry.recordRun({
      workspaceId: 'ws-a', capabilityId: 'cap-x', procedureVersion: 'v1',
      eventId: 'e1', runId: 'r1', learningEligibility: 'positive_procedure', occurredAt: T0,
    });
    assert.equal(typeof res.entry.trustState, 'string');
    assert.equal(res.entry.trustState, TRUST_STATES.INSUFFICIENT_DATA);
  });

  it('needs_review and ineligible runs do not count as evidence', () => {
    const registry = createCapabilityTrustRegistry();
    recordN(registry, {
      workspaceId: 'ws-a', capabilityId: 'cap-y', procedureVersion: 'v1',
      count: 5, eligibility: 'needs_review',
    });
    const res = registry.get('ws-a', 'cap-y');
    assert.equal(res.evidenceWindow.totalCount, 0);
    assert.equal(res.trustState, TRUST_STATES.INSUFFICIENT_DATA);
  });
});

// The fallback anti-erosion counter lives on the registry itself (it was
// exercised only through the removed permitted-fallback tests, #3315).
describe('Capability Trust: fallback-preferred-over counter', () => {
  it('counts on a registered capability and never auto-creates one', () => {
    const registry = createCapabilityTrustRegistry();
    assert.deepEqual(
      registry.incrementFallbackPreferredOverCount({ workspaceId: 'ws-a', capabilityId: 'cap-unknown' }),
      { ok: false, code: 'not_found' },
    );
    assert.equal(registry.get('ws-a', 'cap-unknown').evidenceWindow.totalCount, 0, 'the miss did not register it');

    recordN(registry, { workspaceId: 'ws-a', capabilityId: 'cap-fb', procedureVersion: 'v1', count: 1, eligibility: 'positive_procedure' });
    const first = registry.incrementFallbackPreferredOverCount({ workspaceId: 'ws-a', capabilityId: 'cap-fb' });
    const second = registry.incrementFallbackPreferredOverCount({ workspaceId: 'ws-a', capabilityId: 'cap-fb' });
    assert.equal(first.ok, true);
    assert.equal(first.entry.fallbackPreferredOverCount, 1);
    assert.equal(second.entry.fallbackPreferredOverCount, 2);
    assert.equal(registry.get('ws-a', 'cap-fb').fallbackPreferredOverCount, 2);
    assert.equal(registry.incrementFallbackPreferredOverCount().ok, false, 'no arguments is a miss, not a throw');
  });
});

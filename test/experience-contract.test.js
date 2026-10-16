'use strict';

/**
 * Experience Core E1 — ExperienceContract tests (#2376).
 *
 * Pure admissibility and eligibility rules for `lib/experience/contract.js`.
 * Hermetic: no I/O, no storage, no timers. In particular this file owns the
 * test the E0-b RED suite points at: "repair starts a new attempt and does
 * NOT inherit the old approval".
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  EVENT_TYPES,
  LEARNING_ELIGIBILITY,
  isKnownEventType,
  isTerminalEventType,
  validateEventShape,
  checkLifecycle,
  checkCausality,
  checkRepair,
  admitEvent,
  resolveLearningEligibility,
} = require('../lib/experience/contract');

function validEvent(overrides = {}) {
  return {
    runId: 'run-1',
    workspaceId: 'default',
    eventId: 'e1',
    type: EVENT_TYPES.RUN_STARTED,
    ...overrides,
  };
}

describe('E1: event vocabulary', () => {
  it('knows the lifecycle vocabulary and nothing else', () => {
    for (const type of Object.values(EVENT_TYPES)) assert.equal(isKnownEventType(type), true);
    assert.equal(isKnownEventType('deployed_to_prod'), false);
    assert.equal(isKnownEventType(''), false);
    assert.equal(isKnownEventType(undefined), false);
  });

  it('only run_closed is terminal', () => {
    assert.equal(isTerminalEventType(EVENT_TYPES.RUN_CLOSED), true);
    assert.equal(isTerminalEventType(EVENT_TYPES.FAILURE), false);
    assert.equal(isTerminalEventType(EVENT_TYPES.VERIFICATION), false);
  });
});

describe('E1: event shape', () => {
  it('accepts a well-formed event', () => {
    assert.deepEqual(validateEventShape(validEvent()), { ok: true });
  });

  it('rejects missing identity and unknown types with distinct codes', () => {
    assert.equal(validateEventShape(validEvent({ runId: '' })).code, 'invalid_run_id');
    assert.equal(validateEventShape(validEvent({ eventId: null })).code, 'invalid_event_id');
    assert.equal(validateEventShape(validEvent({ type: 'nope' })).code, 'unknown_event_type');
    assert.equal(validateEventShape(null).code, 'invalid_event');
    assert.equal(validateEventShape([]).code, 'invalid_event');
  });

  it('rejects malformed causality fields and sequences', () => {
    assert.equal(validateEventShape(validEvent({ causedByEventId: '' })).code, 'invalid_causedByEventId');
    assert.equal(validateEventShape(validEvent({ parentRunId: 42 })).code, 'invalid_parentRunId');
    assert.equal(validateEventShape(validEvent({ sequence: 0 })).code, 'invalid_sequence');
    assert.equal(validateEventShape(validEvent({ sequence: 1.5 })).code, 'invalid_sequence');
  });

  it('leaves the payload opaque to the contract', () => {
    assert.deepEqual(validateEventShape(validEvent({ payload: { a: [1, 2, 3] } })), { ok: true });
  });
});

describe('E1: lifecycle vocabulary, not rigid order', () => {
  it('the first event must open the run', () => {
    assert.equal(checkLifecycle([], EVENT_TYPES.RUN_STARTED).ok, true);
    assert.equal(checkLifecycle([], EVENT_TYPES.ACTION_PROPOSED).code, 'run_must_start_first');
  });

  it('never opens the same run twice and never appends after close', () => {
    assert.equal(
      checkLifecycle([EVENT_TYPES.RUN_STARTED], EVENT_TYPES.RUN_STARTED).code,
      'duplicate_run_started',
    );
    assert.equal(
      checkLifecycle([EVENT_TYPES.RUN_STARTED, EVENT_TYPES.RUN_CLOSED], EVENT_TYPES.FAILURE).code,
      'terminal_run',
    );
  });

  it('a failure may arrive after execution_finished or verification', () => {
    const afterFinish = [EVENT_TYPES.RUN_STARTED, EVENT_TYPES.EXECUTION_FINISHED];
    assert.equal(checkLifecycle(afterFinish, EVENT_TYPES.FAILURE).ok, true);
    const afterVerify = [EVENT_TYPES.RUN_STARTED, EVENT_TYPES.VERIFICATION];
    assert.equal(checkLifecycle(afterVerify, EVENT_TYPES.FAILURE).ok, true);
  });
});

describe('E1: causality is not extensible', () => {
  it('a causedBy ref must already be seen in the same run', () => {
    const seen = new Set(['e1']);
    assert.equal(
      checkCausality(seen, validEvent({ causedByEventId: 'e1' })).ok,
      true,
    );
    assert.equal(
      checkCausality(seen, validEvent({ causedByEventId: 'ghost' })).code,
      'unknown_causality_ref',
    );
    assert.equal(checkCausality(seen, validEvent()).ok, true);
  });
});

describe('E1: repair starts a new attempt and inherits no approval', () => {
  const context = { priorAttemptId: 'att-1', priorApprovalId: 'apr-1' };

  it('a repair without a fresh attemptId is refused', () => {
    assert.equal(
      checkRepair(validEvent({ type: EVENT_TYPES.REPAIR_PROPOSED, attemptId: 'att-1' }), context).code,
      'repair_requires_new_attempt',
    );
    assert.equal(
      checkRepair(validEvent({ type: EVENT_TYPES.REPAIR_EXECUTED }), context).code,
      'repair_requires_new_attempt',
    );
  });

  it('a repair carrying the old approval id is refused', () => {
    assert.equal(
      checkRepair(
        validEvent({ type: EVENT_TYPES.REPAIR_PROPOSED, attemptId: 'att-2', approvalId: 'apr-1' }),
        context,
      ).code,
      'repair_inherits_approval',
    );
  });

  it('a repair with a fresh attempt and no carried approval is admitted', () => {
    assert.deepEqual(
      checkRepair(
        validEvent({ type: EVENT_TYPES.REPAIR_PROPOSED, attemptId: 'att-2', approvalId: 'apr-2' }),
        context,
      ),
      { ok: true },
    );
  });

  it('non-repair events are untouched by the repair rule', () => {
    assert.deepEqual(checkRepair(validEvent({ type: EVENT_TYPES.FAILURE }), context), { ok: true });
  });
});

describe('E1: admitEvent judges without mutating', () => {
  it('admits a well-formed proposal against a matching view', () => {
    const view = { types: [EVENT_TYPES.RUN_STARTED], seenIds: new Set(['e1']), closed: false };
    const result = admitEvent(view, validEvent({ eventId: 'e2', type: EVENT_TYPES.ACTION_PROPOSED }));
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(view.types, [EVENT_TYPES.RUN_STARTED], 'the view is read, never mutated');
  });

  it('refuses closed runs before any other check', () => {
    const view = { types: [EVENT_TYPES.RUN_STARTED, EVENT_TYPES.RUN_CLOSED], seenIds: new Set() };
    assert.equal(admitEvent(view, { runId: '', eventId: '', type: 'nope' }).code, 'terminal_run');
  });
});

describe('E1: the three axes stay separate', () => {
  const fullProofs = {
    integrity: true, coverage: true, verification: true, provenance: true, permission: true,
  };

  it('completed + verified + full proofs is positive_procedure', () => {
    assert.deepEqual(
      resolveLearningEligibility({ executionStatus: 'completed', outcomeStatus: 'verified', proofs: fullProofs }),
      { ok: true, eligibility: LEARNING_ELIGIBILITY.POSITIVE_PROCEDURE },
    );
  });

  it('completed alone never yields verified eligibility', () => {
    for (const input of [
      { executionStatus: 'completed' },
      { executionStatus: 'completed', outcomeStatus: 'unknown', proofs: fullProofs },
      { executionStatus: 'completed', outcomeStatus: 'verified' },
      { executionStatus: 'completed', outcomeStatus: 'verified', proofs: { ...fullProofs, provenance: false } },
      { executionStatus: 'completed', outcomeStatus: 'verified', proofs: { ...fullProofs, permission: false } },
    ]) {
      const result = resolveLearningEligibility(input);
      assert.notEqual(
        result.eligibility,
        LEARNING_ELIGIBILITY.POSITIVE_PROCEDURE,
        `must not be positive for ${JSON.stringify(input)}`,
      );
    }
    assert.equal(
      resolveLearningEligibility({ executionStatus: 'completed', outcomeStatus: 'verified' }).eligibility,
      LEARNING_ELIGIBILITY.INELIGIBLE,
    );
  });

  it('failed + failed + permitted failure evidence is negative_example', () => {
    assert.deepEqual(
      resolveLearningEligibility({
        executionStatus: 'failed',
        outcomeStatus: 'failed',
        proofs: { failureEvidence: true, permission: true },
      }),
      { ok: true, eligibility: LEARNING_ELIGIBILITY.NEGATIVE_EXAMPLE },
    );
  });

  it('conflicting verification needs review, never positive', () => {
    assert.deepEqual(
      resolveLearningEligibility({
        executionStatus: 'completed',
        outcomeStatus: 'verified',
        proofs: fullProofs,
        verificationConflicting: true,
      }),
      { ok: true, eligibility: LEARNING_ELIGIBILITY.NEEDS_REVIEW },
    );
  });

  it('undefined combinations are ineligible and extra attributes are ignored', () => {
    assert.equal(resolveLearningEligibility({}).eligibility, LEARNING_ELIGIBILITY.INELIGIBLE);
    assert.equal(
      resolveLearningEligibility({
        executionStatus: 'completed',
        outcomeStatus: 'verified',
        proofs: fullProofs,
        llmInvolved: true,
      }).eligibility,
      LEARNING_ELIGIBILITY.POSITIVE_PROCEDURE,
    );
  });
});

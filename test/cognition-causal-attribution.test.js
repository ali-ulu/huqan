'use strict';

// COG-B (#4392, PR-1): causal attribution needs independent evidence, and a
// repair closes only the named decision/artifact. Execution alone is not cause.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  attributeOutcome, evaluateRepair, ATTRIBUTION, EVIDENCE_KIND,
} = require('../lib/cognition/causal-attribution');

const observation = (extra = {}) => ({
  eventId: 'evt_1', workspaceId: 'ws_1',
  at: '2026-10-31T10:00:00Z', asOf: '2026-10-31T10:00:01Z',
  action: { decisionId: 'd_1', kind: EVIDENCE_KIND.EXECUTION, ref: 'step:1' },
  outcome: { decisionId: 'd_1', state: 'confirmed', kind: EVIDENCE_KIND.JOURNAL_OBSERVATION, ref: 'pair:d_1' },
  ...extra,
});
const causal = (extra = {}) => ({ decisionId: 'd_1', kind: EVIDENCE_KIND.HOST_DECLARED, ref: 'expectation:1', ...extra });
const external = (extra = {}) => ({ kind: EVIDENCE_KIND.EXTERNAL_CAUSE, ref: 'external:proc', ...extra });

test('execution evidence alone never attributes causation', () => {
  const result = attributeOutcome(observation());
  assert.equal(result.status, 'ABSTAIN');
  assert.equal(result.reason, 'execution_is_not_causation');
  assert.equal(result.attribution, ATTRIBUTION.UNKNOWN);
  assert.equal(result.authority, 'SIGNAL_ONLY');
});

test('an independent causal binding attributes the outcome to the agent', () => {
  const result = attributeOutcome(observation({ causal: causal() }));
  assert.equal(result.status, 'MEASURED');
  assert.equal(result.attribution, ATTRIBUTION.AGENT_CAUSED);
  assert.equal(result.reason, 'independent_causal_binding');
  assert.equal(result.dimensions.causal.kind, EVIDENCE_KIND.HOST_DECLARED);
  assert.equal(result.sourceDigest.length, 64);
});

test('a self report is not causal evidence', () => {
  const result = attributeOutcome(observation({ causal: causal({ kind: EVIDENCE_KIND.SELF_REPORT }) }));
  assert.equal(result.status, 'ABSTAIN');
  assert.equal(result.reason, 'self_report_is_not_evidence');
});

test('an external cause is reported as external, not as agent cause', () => {
  const result = attributeOutcome(observation({ external: external() }));
  assert.equal(result.status, 'MEASURED');
  assert.equal(result.attribution, ATTRIBUTION.EXTERNAL);
  assert.equal(result.reason, 'external_cause_observed');
});

test('competing causal and external evidence is a conflict, not a preference', () => {
  const result = attributeOutcome(observation({ causal: causal(), external: external() }));
  assert.equal(result.status, 'MEASURED');
  assert.equal(result.attribution, ATTRIBUTION.CONFLICT);
  assert.equal(result.reason, 'competing_causes');
});

test('bindings that point at another decision abstain', () => {
  assert.equal(attributeOutcome(observation({ causal: causal({ decisionId: 'other' }) })).reason, 'causal_binding_mismatch');
  assert.equal(attributeOutcome(observation({ outcome: { ...observation().outcome, decisionId: 'other' } })).reason, 'outcome_binding_mismatch');
});

test('cross-workspace evidence and non-zoned times are rejected', () => {
  assert.equal(attributeOutcome(observation({ causal: causal({ workspaceId: 'ws_2' }) })).reason, 'cross_workspace_evidence');
  assert.equal(attributeOutcome(observation({ at: '2026-10-31T10:00:02Z' })).reason, 'future_observation');
  assert.equal(attributeOutcome(observation({ at: '2026-10-31T10:00:00' })).reason, 'invalid_input');
});

test('attribution rejects malformed input, is frozen and deterministic', () => {
  const input = observation({ causal: causal() });
  const snapshot = JSON.stringify(input);
  const first = attributeOutcome(input);
  assert.equal(attributeOutcome(null).status, 'REJECT');
  assert.equal(attributeOutcome({ ...input, extra: 1 }).status, 'REJECT');
  assert.ok(Object.isFrozen(first));
  assert.equal(JSON.stringify(input), snapshot);
  assert.deepEqual(attributeOutcome({ ...input }), first);
  const changed = attributeOutcome({ ...input, causal: causal({ ref: 'expectation:2' }) });
  assert.notEqual(changed.sourceDigest, first.sourceDigest);
});

const errorContext = (extra = {}) => ({
  error: { decisionId: 'd_1', artifactRef: 'artifact:1', family: 'coder:array-map', status: 'open', ...extra },
  laterSuccesses: [],
});
const repair = (extra = {}) => ({
  repairId: 'r_1', workspaceId: 'ws_1',
  at: '2026-10-31T10:00:00Z', asOf: '2026-10-31T10:00:01Z',
  target: { decisionId: 'd_1', kind: EVIDENCE_KIND.JOURNAL_OBSERVATION, ref: 'outcome:d_1' },
  executor: { actorRef: 'agent:1' },
  verification: { verdict: 'confirmed', verifierRef: 'human:1',
    kind: EVIDENCE_KIND.INDEPENDENT_VERIFICATION, ref: 'verify:1' },
  ...extra,
});

test('a specific independently verified repair closes the named error', () => {
  const result = evaluateRepair(repair(), errorContext());
  assert.equal(result.status, 'MEASURED');
  assert.equal(result.closure, 'CLOSED');
  assert.equal(result.errorStatusBefore, 'open');
  assert.equal(result.authority, 'SIGNAL_ONLY');
  assert.equal(result.sourceDigest.length, 64);
});

test('an artifact reference can identify the repaired error too', () => {
  const result = evaluateRepair(repair({ target: { artifactRef: 'artifact:1',
    kind: EVIDENCE_KIND.JOURNAL_OBSERVATION, ref: 'outcome:d_1' } }), errorContext());
  assert.equal(result.closure, 'CLOSED');
});

test('a family-level later success cannot stand in for a specific repair', () => {
  const result = evaluateRepair(repair({ target: { decisionId: 'later',
    kind: EVIDENCE_KIND.JOURNAL_OBSERVATION, ref: 'outcome:later' } }),
  { ...errorContext(), laterSuccesses: [{ decisionId: 'later', family: 'coder:array-map' }] });
  assert.equal(result.status, 'ABSTAIN');
  assert.equal(result.closure, 'WITHHELD');
  assert.equal(result.reason, 'repair_target_not_specific');
});

test('the agent cannot verify its own repair', () => {
  const sameActor = evaluateRepair(repair({ verification: { verdict: 'confirmed',
    verifierRef: 'agent:1', kind: EVIDENCE_KIND.INDEPENDENT_VERIFICATION, ref: 'verify:1' } }), errorContext());
  assert.equal(sameActor.reason, 'self_verification');
  const selfReport = evaluateRepair(repair({ verification: { verdict: 'confirmed',
    verifierRef: 'human:1', kind: EVIDENCE_KIND.SELF_REPORT, ref: 'verify:1' } }), errorContext());
  assert.equal(selfReport.reason, 'self_verification');
});

test('unverified, duplicate and already closed repairs stay withheld', () => {
  const contradicted = evaluateRepair(repair({ verification: { verdict: 'contradiction',
    verifierRef: 'human:1', kind: EVIDENCE_KIND.INDEPENDENT_VERIFICATION, ref: 'verify:1' } }), errorContext());
  assert.equal(contradicted.reason, 'repair_not_verified');
  assert.equal(evaluateRepair(repair(), errorContext({ status: 'closed' })).reason, 'already_closed');
  assert.equal(evaluateRepair(repair(), errorContext({ closedBy: ['r_1'] })).reason, 'already_closed');
});

test('repair evaluation rejects malformed input and does not mutate it', () => {
  const input = repair();
  const context = errorContext();
  const snapshot = JSON.stringify({ input, context });
  assert.equal(evaluateRepair(null, context).status, 'REJECT');
  assert.equal(evaluateRepair(input, null).status, 'REJECT');
  assert.equal(evaluateRepair(input, { error: { decisionId: 'd_1', workspaceId: 'ws_2' } }).reason, 'cross_workspace_evidence');
  const result = evaluateRepair(input, context);
  assert.ok(Object.isFrozen(result));
  assert.equal(JSON.stringify({ input, context }), snapshot);
});

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PRIVILEGE_ESCALATION_REASON,
  DEFAULT_MAX_SESSIONS,
  createEscalationLedger,
  observeIdentityScope,
  privilegeEscalationOptions,
  evaluateIdentityEscalation,
} = require('../lib/identity-privilege-escalation');

function scope(overrides = {}) {
  return {
    sessionId: 'session-1',
    identityRef: 'agent:ws-1:agent-1',
    capabilities: ['tool'],
    ...overrides,
  };
}

test('a first observation in a session is never an escalation', () => {
  const ledger = createEscalationLedger();
  const result = observeIdentityScope(ledger, scope());

  assert.equal(result.escalated, false);
  assert.deepEqual(result.addedCapabilities, []);
  assert.deepEqual(result.priorCapabilities, []);
  assert.deepEqual(result.observedCapabilities, ['tool']);
});

test('re-presenting the same capabilities is not an escalation', () => {
  const ledger = createEscalationLedger();
  observeIdentityScope(ledger, scope());
  const result = observeIdentityScope(ledger, scope());

  assert.equal(result.escalated, false);
  assert.deepEqual(result.addedCapabilities, []);
});

test('a narrower card later in the session is not an escalation', () => {
  const ledger = createEscalationLedger();
  observeIdentityScope(ledger, scope({ capabilities: ['tool', 'deployment'] }));
  const result = observeIdentityScope(ledger, scope({ capabilities: ['tool'] }));

  assert.equal(result.escalated, false);
  assert.deepEqual(result.addedCapabilities, []);
});

test('a capability the session never held before is an escalation', () => {
  const ledger = createEscalationLedger();
  observeIdentityScope(ledger, scope({ capabilities: ['tool'] }));
  const result = observeIdentityScope(ledger, scope({ capabilities: ['tool', 'deployment'] }));

  assert.equal(result.escalated, true);
  assert.equal(result.reason, PRIVILEGE_ESCALATION_REASON);
  assert.deepEqual(result.addedCapabilities, ['deployment']);
  assert.deepEqual(result.priorCapabilities, ['tool']);
});

test('escalation is detected against the union of the whole session, not just the previous card', () => {
  const ledger = createEscalationLedger();
  observeIdentityScope(ledger, scope({ capabilities: ['tool', 'deployment'] }));
  observeIdentityScope(ledger, scope({ capabilities: ['tool'] }));
  const result = observeIdentityScope(ledger, scope({ capabilities: ['deployment'] }));

  assert.equal(result.escalated, false, 'deployment was already held earlier in this session');
});

test('a wildcard arriving after a narrow card is an escalation', () => {
  const ledger = createEscalationLedger();
  observeIdentityScope(ledger, scope({ capabilities: ['tool'] }));
  const result = observeIdentityScope(ledger, scope({ capabilities: ['*'] }));

  assert.equal(result.escalated, true);
  assert.deepEqual(result.addedCapabilities, ['*']);
});

test('two identities in one session accumulate separately', () => {
  const ledger = createEscalationLedger();
  observeIdentityScope(ledger, scope({ identityRef: 'agent:ws-1:agent-1', capabilities: ['deployment'] }));
  const result = observeIdentityScope(ledger, scope({ identityRef: 'agent:ws-1:agent-2', capabilities: ['deployment'] }));

  assert.equal(result.escalated, false, "agent-2's first card is its own baseline");
  assert.deepEqual(result.priorCapabilities, []);
});

test('the same identity in a different session starts from a clean baseline', () => {
  const ledger = createEscalationLedger();
  observeIdentityScope(ledger, scope({ sessionId: 'session-1', capabilities: ['tool'] }));
  const result = observeIdentityScope(ledger, scope({ sessionId: 'session-2', capabilities: ['deployment'] }));

  assert.equal(result.escalated, false);
});

test('an unidentified session is reported as untracked rather than silently allowed', () => {
  const ledger = createEscalationLedger();
  observeIdentityScope(ledger, scope({ capabilities: ['tool'] }));
  const result = observeIdentityScope(ledger, scope({ sessionId: '', capabilities: ['deployment'] }));

  assert.equal(result.escalated, false);
  assert.equal(result.tracked, false, 'no session key means no accumulation is possible');
});

test('the ledger is bounded and evicts the least recently seen session', () => {
  const ledger = createEscalationLedger({ maxSessions: 2 });
  observeIdentityScope(ledger, scope({ sessionId: 's1', capabilities: ['tool'] }));
  observeIdentityScope(ledger, scope({ sessionId: 's2', capabilities: ['tool'] }));
  observeIdentityScope(ledger, scope({ sessionId: 's3', capabilities: ['tool'] }));

  assert.equal(ledger.size, 2);

  // s1 was evicted, so its history is gone and a wider card reads as a baseline.
  const result = observeIdentityScope(ledger, scope({ sessionId: 's1', capabilities: ['deployment'] }));
  assert.equal(result.escalated, false);
});

test('DEFAULT_MAX_SESSIONS is a finite bound', () => {
  assert.ok(Number.isInteger(DEFAULT_MAX_SESSIONS) && DEFAULT_MAX_SESSIONS > 0);
});

test('unknown capability strings are still tracked, so an off-vocabulary grant cannot hide', () => {
  const ledger = createEscalationLedger();
  observeIdentityScope(ledger, scope({ capabilities: ['tool'] }));
  const result = observeIdentityScope(ledger, scope({ capabilities: ['tool', 'not-in-vocabulary'] }));

  assert.equal(result.escalated, true);
  assert.deepEqual(result.addedCapabilities, ['not-in-vocabulary']);
});

function envelopeFor(sessionId) {
  return { session: { id: sessionId } };
}

function identityFor(capabilities) {
  return { identityRef: 'agent:ws-1:agent-1', identityHash: 'h', attested: true, capabilities };
}

test('privilegeEscalationOptions is null unless the deployment opts in', () => {
  assert.equal(privilegeEscalationOptions({ environment: {} }), null);
  assert.equal(privilegeEscalationOptions({ privilegeEscalation: { enabled: false }, environment: {} }), null);
});

test('privilegeEscalationOptions opts in via config and via environment flag', () => {
  const viaConfig = privilegeEscalationOptions({ privilegeEscalation: { enabled: true }, environment: {} });
  assert.equal(viaConfig.decision, 'review', 'review is the default verdict, not block');

  const viaEnv = privilegeEscalationOptions({ environment: { HUQAN_EXTERNAL_GUARD_PRIVILEGE_ESCALATION: 'block' } });
  assert.equal(viaEnv.decision, 'block');
});

test('evaluateIdentityEscalation returns null while authority has not widened', () => {
  const config = privilegeEscalationOptions({ privilegeEscalation: { enabled: true }, environment: {} });
  const first = evaluateIdentityEscalation({
    envelope: envelopeFor('s-1'),
    identity: identityFor(['tool']),
  }, config);

  assert.equal(first, null);
});

test('evaluateIdentityEscalation reports a finding when the card widens mid-session', () => {
  const config = privilegeEscalationOptions({ privilegeEscalation: { enabled: true }, environment: {} });
  evaluateIdentityEscalation({ envelope: envelopeFor('s-2'), identity: identityFor(['tool']) }, config);
  const widened = evaluateIdentityEscalation({
    envelope: envelopeFor('s-2'),
    identity: identityFor(['tool', 'deployment']),
  }, config);

  assert.equal(widened.gate, 'identity-escalation');
  assert.equal(widened.decision, 'review');
  assert.equal(widened.reason, PRIVILEGE_ESCALATION_REASON);
  assert.deepEqual(widened.addedCapabilities, ['deployment']);
  assert.equal(widened.identityRef, 'agent:ws-1:agent-1');
});

test('the default ledger is shared across calls, because options are rebuilt on every guarded action', () => {
  const configA = privilegeEscalationOptions({ privilegeEscalation: { enabled: true }, environment: {} });
  const configB = privilegeEscalationOptions({ privilegeEscalation: { enabled: true }, environment: {} });
  evaluateIdentityEscalation({ envelope: envelopeFor('s-3'), identity: identityFor(['tool']) }, configA);
  const onB = evaluateIdentityEscalation({
    envelope: envelopeFor('s-3'),
    identity: identityFor(['tool', 'shell']),
  }, configB);

  assert.ok(onB, 'a per-config ledger would reset history every call and never fire');
  assert.deepEqual(onB.addedCapabilities, ['shell']);
});

test('a supplied ledger isolates history from the shared default', () => {
  const ledger = createEscalationLedger();
  const isolated = privilegeEscalationOptions({ privilegeEscalation: { enabled: true, ledger }, environment: {} });
  const shared = privilegeEscalationOptions({ privilegeEscalation: { enabled: true }, environment: {} });
  evaluateIdentityEscalation({ envelope: envelopeFor('s-4'), identity: identityFor(['tool']) }, shared);
  const onIsolated = evaluateIdentityEscalation({
    envelope: envelopeFor('s-4'),
    identity: identityFor(['tool', 'shell']),
  }, isolated);

  assert.equal(onIsolated, null, 'the supplied ledger has never seen this session');
});

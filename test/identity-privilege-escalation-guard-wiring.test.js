'use strict';

/**
 * Wiring proof for #1891. `identity-privilege-escalation.test.js` proves the
 * detector's logic in isolation; this file proves the guard actually calls it,
 * which is the part a unit test can never show. A module that is correct and
 * unreachable is the failure mode this file exists to catch.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { AGENT_IDENTITY_CARD_SCHEMA_VERSION } = require('../lib/external-action-identity');
const {
  PRIVILEGE_ESCALATION_REASON,
  createEscalationLedger,
} = require('../lib/identity-privilege-escalation');
const { evaluateExternalAction } = require('../lib/external-action-guard');

const ISSUED_AT = '2026-01-01T00:00:00.000Z';
const WORKSPACE_ROOT = process.cwd();
const IN_WORKSPACE_FILE = path.join(WORKSPACE_ROOT, 'README.md');

function card(capabilities) {
  return {
    schemaVersion: AGENT_IDENTITY_CARD_SCHEMA_VERSION,
    agentId: 'escalating-agent',
    agentName: 'escalating-agent',
    agentVersion: '1.0.0',
    ownerActorId: 'actor:ali',
    workspaceId: 'default',
    capabilities,
    issuedAt: ISSUED_AT,
  };
}

function invocation(sessionId, capabilities) {
  return {
    invocationId: `inv-${sessionId}`,
    agentName: 'escalating-agent',
    sessionId,
    turnId: 'turn-1',
    toolName: 'Read',
    args: { file_path: IN_WORKSPACE_FILE },
    cwd: WORKSPACE_ROOT,
    workspaceRoot: WORKSPACE_ROOT,
    workspaceId: 'default',
    identity: card(capabilities),
  };
}

function escalationFinding(result) {
  return result.findings.find((finding) => finding.gate === 'identity-escalation');
}

test('an unconfigured guard records no escalation finding, even for a widening card', () => {
  const options = { environment: {} };
  evaluateExternalAction(invocation('unconfigured-session', ['file_read']), options);
  const widened = evaluateExternalAction(
    invocation('unconfigured-session', ['file_read', 'shell']),
    options,
  );

  assert.equal(escalationFinding(widened), undefined, 'opt-in means unchanged by default');
});

test('the guard flags a card that widens mid-session once the detector is enabled', () => {
  const ledger = createEscalationLedger();
  const options = { environment: {}, privilegeEscalation: { enabled: true, ledger } };

  const first = evaluateExternalAction(invocation('widening-session', ['file_read']), options);
  assert.equal(escalationFinding(first), undefined, 'the first card is the session baseline');

  const widened = evaluateExternalAction(
    invocation('widening-session', ['file_read', 'shell']),
    options,
  );
  const finding = escalationFinding(widened);

  assert.ok(finding, 'the guard must reach the detector');
  assert.equal(finding.reason, PRIVILEGE_ESCALATION_REASON);
  assert.deepEqual(finding.addedCapabilities, ['shell']);
  assert.equal(finding.identityRef, 'agent:default:escalating-agent');
  assert.notEqual(widened.decision, 'allow', 'a widened card cannot stay a plain allow');
});

test('the environment flag alone is enough to reach the detector across separate guard calls', () => {
  const options = { environment: { HUQAN_EXTERNAL_GUARD_PRIVILEGE_ESCALATION: 'review' } };

  evaluateExternalAction(invocation('env-flag-session', ['file_read']), options);
  const widened = evaluateExternalAction(
    invocation('env-flag-session', ['file_read', 'shell']),
    options,
  );

  assert.ok(
    escalationFinding(widened),
    'options are rebuilt per call, so this fails if the default ledger is not shared',
  );
});

test('a repeated identical card never produces an escalation finding', () => {
  const ledger = createEscalationLedger();
  const options = { environment: {}, privilegeEscalation: { enabled: true, ledger } };

  evaluateExternalAction(invocation('steady-session', ['file_read', 'shell']), options);
  const again = evaluateExternalAction(invocation('steady-session', ['file_read', 'shell']), options);

  assert.equal(escalationFinding(again), undefined);
});

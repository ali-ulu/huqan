'use strict';

/**
 * #2048 - a custom agent has no artifact to inspect, so its gate status is an
 * observation of the receipt trail. These tests pin what that observation may
 * and may not claim.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CUSTOM_AGENT_GATE_STATES,
  customAgentGateStatus,
} = require('../lib/external-action-custom-agent-status');
const { manageGate } = require('../lib/external-action-gate-install');

const KNOWN_PROFILES = ['claude-code', 'codex', 'opencode', 'pi', 'hermes'];

function receiptLine(overrides = {}) {
  const agentName = overrides.agentName || 'my-agent';
  return JSON.stringify({
    receiptId: overrides.receiptId || `xact_${agentName}_1`,
    receiptKind: 'external_action_admission_receipt',
    decision: overrides.decision || 'allow',
    reason: overrides.reason || 'policy',
    actor: agentName,
    workspaceId: 'default',
    createdAt: overrides.createdAt || '2026-09-10T00:00:00.000Z',
    metadata: {
      identity: {
        attested: false,
        identityRef: `agent:default:${agentName}`,
        identityHash: '',
        agentId: agentName,
        agentName,
        ownerActorId: '',
        onBehalfOf: '',
        workspaceId: 'default',
      },
    },
  });
}

function trail(t, lines) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-2048-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'receipts.jsonl');
  if (lines !== null) fs.writeFileSync(target, lines.length ? `${lines.join('\n')}\n` : '');
  return target;
}

test('a trail that was never written means the agent is not calling HUQAN', (t) => {
  const status = customAgentGateStatus(trail(t, null), { knownProfiles: KNOWN_PROFILES });

  assert.equal(status.state, CUSTOM_AGENT_GATE_STATES.NO_INVOCATION);
  assert.equal(status.invocations, 0);
  assert.equal(status.lastInvocationAt, null);
});

test('an arriving envelope is observed, with its decision counted', (t) => {
  const target = trail(t, [
    receiptLine({ decision: 'allow', createdAt: '2026-09-10T00:00:00.000Z' }),
    receiptLine({ decision: 'block', createdAt: '2026-09-10T01:00:00.000Z', receiptId: 'xact_my_2' }),
  ]);

  const status = customAgentGateStatus(target, { knownProfiles: KNOWN_PROFILES });

  assert.equal(status.state, CUSTOM_AGENT_GATE_STATES.ENVELOPE_OBSERVED);
  assert.equal(status.invocations, 2);
  assert.equal(status.lastInvocationAt, '2026-09-10T01:00:00.000Z');
  assert.deepEqual(status.byDecision, { allow: 1, block: 1 });
  assert.deepEqual(status.agents, ['my-agent']);
});

// The trap this whole surface exists to avoid: an installed Codex gate is busy
// and honest, and says nothing whatsoever about whether the user's own agent
// is wired up.
test('an installed profile\'s invocations are not evidence for a custom agent', (t) => {
  const target = trail(t, [
    receiptLine({ agentName: 'codex' }),
    receiptLine({ agentName: 'claude-code' }),
  ]);

  const status = customAgentGateStatus(target, { knownProfiles: KNOWN_PROFILES });

  assert.equal(
    status.state,
    CUSTOM_AGENT_GATE_STATES.NO_INVOCATION,
    'a running Codex gate must not be reported as a connected custom agent',
  );
  assert.equal(status.invocations, 0);
});

test('agentName narrows the observation to one agent', (t) => {
  const target = trail(t, [
    receiptLine({ agentName: 'my-agent' }),
    receiptLine({ agentName: 'other-agent', receiptId: 'xact_other_1' }),
  ]);

  assert.equal(customAgentGateStatus(target, { knownProfiles: KNOWN_PROFILES, agentName: 'my-agent' }).invocations, 1);
  assert.equal(customAgentGateStatus(target, { knownProfiles: KNOWN_PROFILES, agentName: 'nobody' }).state, CUSTOM_AGENT_GATE_STATES.NO_INVOCATION);
  // A name that matches an installed profile is still answerable when asked
  // for explicitly: the exclusion exists to stop it counting by default.
  assert.equal(customAgentGateStatus(target, { knownProfiles: KNOWN_PROFILES, agentName: 'other-agent' }).invocations, 1);
});

test('the observation states what it cannot prove', (t) => {
  const status = customAgentGateStatus(trail(t, [receiptLine({ decision: 'block' })]), { knownProfiles: KNOWN_PROFILES });

  assert.match(status.observationLimit, /does not prove/i);
  assert.match(status.observationLimit, /honoured/i);
  // No `installed` field: there is no artifact, and false would read as
  // "not installed" rather than "unknowable".
  assert.equal(Object.hasOwn(status, 'installed'), false);
});

test('an unreadable trail is reported as unreadable, not as no invocations', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-2048-dir-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // A directory where a file is expected: readable path, unreadable trail.
  const status = customAgentGateStatus(root, { knownProfiles: KNOWN_PROFILES });

  assert.equal(status.state, CUSTOM_AGENT_GATE_STATES.UNREADABLE);
  assert.notEqual(status.state, CUSTOM_AGENT_GATE_STATES.NO_INVOCATION);
});

test('status --profile generic answers instead of refusing', (t) => {
  const target = trail(t, [receiptLine({})]);

  const result = manageGate('status', {
    deploymentAuthorized: true,
    profile: 'generic',
    receiptPath: target,
  });

  assert.equal(result.command, 'status');
  assert.deepEqual(result.clients, [], 'there is no artifact-backed client for a custom agent');
  assert.equal(result.custom.state, CUSTOM_AGENT_GATE_STATES.ENVELOPE_OBSERVED);
  assert.equal(result.custom.invocations, 1);
});

test('the profile-less status listing carries the custom-agent observation too', (t) => {
  const target = trail(t, [receiptLine({})]);

  const result = manageGate('status', {
    deploymentAuthorized: true,
    receiptPath: target,
    root: path.dirname(target),
    home: path.dirname(target),
  });

  assert.equal(result.custom.state, CUSTOM_AGENT_GATE_STATES.ENVELOPE_OBSERVED);
  assert.equal(result.clients.length, KNOWN_PROFILES.length);
});

test('install --profile generic refuses by naming the envelope path', (t) => {
  const target = trail(t, []);

  assert.throws(
    () => manageGate('install', { deploymentAuthorized: true, profile: 'generic', receiptPath: target }),
    (error) => {
      assert.match(error.message, /huqan\.external-action\.v1/);
      assert.match(error.message, /status --profile generic/);
      assert.doesNotMatch(error.message, /unsupported profile/);
      return true;
    },
  );
});

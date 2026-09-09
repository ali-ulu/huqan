'use strict';

/**
 * #2052 - the roster behind an agent monitoring view: which agents have acted,
 * and what a row is allowed to claim about them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildAgentRoster, AGENT_ATTESTATION } = require('../lib/external-action-agent-roster');

function line(overrides = {}) {
  const agentId = overrides.agentId || 'my-agent';
  const workspaceId = overrides.workspaceId || 'default';
  return JSON.stringify({
    receiptId: overrides.receiptId || `xact_${agentId}_${Math.random().toString(16).slice(2)}`,
    receiptKind: 'external_action_admission_receipt',
    decision: overrides.decision || 'allow',
    actor: agentId,
    workspaceId,
    createdAt: overrides.createdAt || '2026-09-10T00:00:00.000Z',
    metadata: {
      toolKind: overrides.toolKind || 'shell',
      identity: {
        attested: overrides.attested === true,
        identityRef: overrides.identityRef || `agent:${workspaceId}:${agentId}`,
        identityHash: '',
        agentId,
        agentName: overrides.agentName || agentId,
        ownerActorId: overrides.ownerActorId || '',
        onBehalfOf: '',
        sessionId: overrides.sessionId || 'session-1',
        workspaceId,
      },
    },
  });
}

function trail(t, lines) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-2052-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const target = path.join(base, 'receipts.jsonl');
  if (lines !== null) fs.writeFileSync(target, lines.length ? `${lines.join('\n')}\n` : '');
  return target;
}

test('an empty trail lists no agents rather than failing', (t) => {
  const roster = buildAgentRoster(trail(t, null));
  assert.equal(roster.ok, true);
  assert.deepEqual(roster.agents, []);
});

test('an agent row carries what it did, not just that it exists', (t) => {
  const roster = buildAgentRoster(trail(t, [
    line({ decision: 'allow', toolKind: 'shell', createdAt: '2026-09-10T00:00:00.000Z' }),
    line({ decision: 'block', toolKind: 'shell', createdAt: '2026-09-10T02:00:00.000Z' }),
    line({ decision: 'review', toolKind: 'file', createdAt: '2026-09-10T01:00:00.000Z' }),
  ]));

  assert.equal(roster.agents.length, 1);
  const [agent] = roster.agents;
  assert.equal(agent.identityRef, 'agent:default:my-agent');
  assert.equal(agent.actions, 3);
  assert.deepEqual(agent.byDecision, { allow: 1, block: 1, review: 1 });
  assert.deepEqual(agent.byToolKind, { shell: 2, file: 1 });
  assert.equal(agent.firstAt, '2026-09-10T00:00:00.000Z');
  assert.equal(agent.lastAt, '2026-09-10T02:00:00.000Z');
});

// The claim a monitoring view must never make. An envelope-carried name is a
// claim; two distinct identities may carry the same one, and merging them would
// let one agent's record absorb another's.
test('two identities claiming the same name stay separate rows', (t) => {
  const roster = buildAgentRoster(trail(t, [
    line({ agentId: 'shipper', identityRef: 'agent:default:shipper', agentName: 'deploy-bot' }),
    line({ agentId: 'intruder', identityRef: 'agent:default:intruder', agentName: 'deploy-bot' }),
  ]));

  assert.equal(roster.agents.length, 2, 'a shared name must not merge two identities');
  for (const agent of roster.agents) {
    assert.equal(agent.agentName, 'deploy-bot');
    assert.equal(agent.nameCollision, true, 'the collision must be visible, not resolved');
  }
  assert.notEqual(roster.agents[0].identityRef, roster.agents[1].identityRef);
});

test('a name nobody else claims is not flagged as a collision', (t) => {
  const roster = buildAgentRoster(trail(t, [line({ agentId: 'solo' })]));
  assert.equal(roster.agents[0].nameCollision, false);
});

test('attestation is reported per identity', (t) => {
  const roster = buildAgentRoster(trail(t, [
    line({ agentId: 'carded', identityRef: 'agent:default:carded', attested: true }),
    line({ agentId: 'plain', identityRef: 'agent:default:plain', attested: false }),
  ]));

  const byRef = Object.fromEntries(roster.agents.map(agent => [agent.identityRef, agent]));
  assert.equal(byRef['agent:default:carded'].attestation, AGENT_ATTESTATION.ATTESTED);
  assert.equal(byRef['agent:default:plain'].attestation, AGENT_ATTESTATION.UNATTESTED);
});

// Averaging this into one boolean would hide the unattested half, which is the
// half a reader needs to see.
test('an identity that acted both with and without a card is mixed, not attested', (t) => {
  const roster = buildAgentRoster(trail(t, [
    line({ agentId: 'sometimes', identityRef: 'agent:default:sometimes', attested: true }),
    line({ agentId: 'sometimes', identityRef: 'agent:default:sometimes', attested: false }),
  ]));

  const [agent] = roster.agents;
  assert.equal(agent.attestation, AGENT_ATTESTATION.MIXED);
  assert.equal(agent.attestedActions, 1);
  assert.equal(agent.unattestedActions, 1);
});

test('a receipt with no attributable identity is not filed under a guessed name', (t) => {
  const orphan = JSON.stringify({
    receiptId: 'xact_orphan',
    receiptKind: 'external_action_admission_receipt',
    decision: 'allow',
    createdAt: '2026-09-10T00:00:00.000Z',
    metadata: { identity: { attested: false, identityRef: '', agentId: '', agentName: '' } },
  });

  const roster = buildAgentRoster(trail(t, [orphan, line({})]));
  assert.equal(roster.agents.length, 1);
  assert.equal(roster.agents[0].identityRef, 'agent:default:my-agent');
});

test('rows are ordered by most recent activity', (t) => {
  const roster = buildAgentRoster(trail(t, [
    line({ agentId: 'stale', identityRef: 'agent:default:stale', createdAt: '2026-09-01T00:00:00.000Z' }),
    line({ agentId: 'fresh', identityRef: 'agent:default:fresh', createdAt: '2026-09-10T00:00:00.000Z' }),
  ]));

  assert.deepEqual(roster.agents.map(agent => agent.agentId), ['fresh', 'stale']);
});

test('the roster narrows by workspace and by time', (t) => {
  const target = trail(t, [
    line({ agentId: 'a', identityRef: 'agent:team-a:a', workspaceId: 'team-a', createdAt: '2026-09-01T00:00:00.000Z' }),
    line({ agentId: 'b', identityRef: 'agent:team-b:b', workspaceId: 'team-b', createdAt: '2026-09-10T00:00:00.000Z' }),
  ]);

  assert.deepEqual(buildAgentRoster(target, { workspaceId: 'team-a' }).agents.map(a => a.agentId), ['a']);
  assert.deepEqual(buildAgentRoster(target, { since: '2026-09-05T00:00:00.000Z' }).agents.map(a => a.agentId), ['b']);
});

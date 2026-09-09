'use strict';

/**
 * #2060 - the joined view behind an agent monitoring tab: connected agents and
 * acting agents in one list, with neither inferred from the other.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildAgentOverview, AGENT_ACTIVITY } = require('../lib/external-action-agent-overview');

function receiptLine(agentName, overrides = {}) {
  const workspaceId = overrides.workspaceId || 'default';
  return JSON.stringify({
    receiptId: `xact_${agentName}_${Math.random().toString(16).slice(2)}`,
    receiptKind: 'external_action_admission_receipt',
    decision: overrides.decision || 'allow',
    actor: agentName,
    workspaceId,
    createdAt: overrides.createdAt || '2026-09-10T00:00:00.000Z',
    metadata: {
      toolKind: 'shell',
      identity: {
        attested: false,
        identityRef: `agent:${workspaceId}:${agentName}`,
        agentId: agentName,
        agentName,
        ownerActorId: '',
        workspaceId,
      },
    },
  });
}

function place(t, lines = []) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-2060-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'proj');
  const home = path.join(base, 'home');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const receiptPath = path.join(base, 'receipts.jsonl');
  fs.writeFileSync(receiptPath, lines.length ? `${lines.join('\n')}\n` : '');
  return { root, home, receiptPath };
}

function find(overview, label) {
  return overview.agents.find(agent => agent.label === label || agent.profile === label);
}

test('every installable profile appears even with nothing installed and nothing acted', (t) => {
  const overview = buildAgentOverview(place(t));

  assert.equal(overview.ok, true);
  assert.equal(overview.connected, 0);
  assert.equal(overview.acting, 0);
  assert.ok(find(overview, 'codex'), 'a profile must be listed before it is connected');
  assert.equal(find(overview, 'codex').activity, AGENT_ACTIVITY.SILENT);
});

// The row the whole join exists for. A brand-new install and a gate the agent
// never calls look identical from either source alone.
test('a connected agent that has never acted is listed as silent, not as working', (t) => {
  const spot = place(t);
  // A real claude-code install writes this file; the overview reads whether it
  // is there, not whether the agent used it.
  fs.mkdirSync(path.join(spot.root, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(spot.root, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { PreToolUse: [] } }),
  );

  const claude = find(buildAgentOverview(spot), 'claude-code');

  assert.equal(claude.activity, AGENT_ACTIVITY.SILENT);
  assert.equal(claude.actions, 0);
  assert.equal(claude.lastInvocationAt, null);
});

test('an agent that has acted carries what it did onto its profile row', (t) => {
  const spot = place(t, [
    receiptLine('codex', { decision: 'allow', createdAt: '2026-09-10T00:00:00.000Z' }),
    receiptLine('codex', { decision: 'block', createdAt: '2026-09-10T03:00:00.000Z' }),
  ]);

  const codex = find(buildAgentOverview(spot), 'codex');

  assert.equal(codex.kind, 'profile');
  assert.equal(codex.activity, AGENT_ACTIVITY.ACTIVE);
  assert.equal(codex.actions, 2);
  assert.deepEqual(codex.byDecision, { allow: 1, block: 1 });
  assert.equal(codex.lastInvocationAt, '2026-09-10T03:00:00.000Z');
});

// Acting is not evidence of being connected: the install may have been removed
// after the fact, and hiding the row would hide exactly that.
test('an agent that acted without being connected is still listed', (t) => {
  const spot = place(t, [receiptLine('codex')]);

  const codex = find(buildAgentOverview(spot), 'codex');

  assert.equal(codex.connected, false, 'no artifact is installed');
  assert.equal(codex.activity, AGENT_ACTIVITY.ACTIVE);
});

test('a custom agent is listed with connection unknowable, not false', (t) => {
  const spot = place(t, [receiptLine('my-agent')]);

  const custom = find(buildAgentOverview(spot), 'my-agent');

  assert.equal(custom.kind, 'custom');
  assert.equal(
    custom.connected,
    null,
    'a custom agent has no artifact to inspect, so connection is unknowable rather than no',
  );
  assert.equal(custom.activity, AGENT_ACTIVITY.ACTIVE);
  assert.equal(custom.actions, 1);
});

test('a custom agent is never folded into a profile row', (t) => {
  const spot = place(t, [receiptLine('codex'), receiptLine('my-agent')]);
  const overview = buildAgentOverview(spot);

  assert.equal(find(overview, 'codex').actions, 1);
  assert.equal(find(overview, 'my-agent').actions, 1);
  assert.equal(overview.acting, 2);
});

test('one profile acting in several workspaces keeps each identity visible', (t) => {
  const spot = place(t, [
    receiptLine('codex', { workspaceId: 'team-a' }),
    receiptLine('codex', { workspaceId: 'team-b' }),
  ]);

  const codex = find(buildAgentOverview(spot), 'codex');

  assert.equal(codex.actions, 2);
  assert.equal(codex.identities.length, 2, 'two workspaces are two identities');
  assert.deepEqual(
    codex.identities.map(identity => identity.identityRef).sort(),
    ['agent:team-a:codex', 'agent:team-b:codex'],
  );
});

test('the roster narrows by workspace without dropping the profile rows', (t) => {
  const spot = place(t, [
    receiptLine('codex', { workspaceId: 'team-a' }),
    receiptLine('codex', { workspaceId: 'team-b' }),
  ]);

  const overview = buildAgentOverview({ ...spot, workspaceId: 'team-a' });
  const codex = find(overview, 'codex');

  assert.equal(codex.actions, 1);
  assert.equal(codex.identities.length, 1);
  assert.ok(find(overview, 'pi'), 'profiles with no activity are still listed');
});

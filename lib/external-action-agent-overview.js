'use strict';

const fs = require('node:fs');
const { PROFILES, manageGate } = require('./external-action-gate-install');
const { DETECTABLE_AGENTS } = require('./external-action-agent-detection');
const { buildAgentRoster } = require('./external-action-agent-roster');

/**
 * Connected agents and acting agents, side by side (#2060).
 *
 * connect() knows what it installed. buildAgentRoster() knows what has acted.
 * Neither knows the other, so a freshly connected agent appeared in no list at
 * all -- a monitoring view built on the roster alone shows nothing at the exact
 * moment the user has just protected everything.
 *
 * The join produces the state neither side can report: **connected and silent**.
 * That is either a new install or the failure #2048 exists to detect -- the
 * artifact is in place but the agent never calls it. Which one it is cannot be
 * derived here, so the row carries `installedAt` and `lastInvocationAt` and
 * lets the reader judge, rather than asserting a cause.
 *
 * Nothing is inferred across the two sources. A connected agent that has never
 * acted is not reported as working, and an agent that acts without being
 * connected is not hidden -- it acted through the generic path, or its install
 * was removed afterwards, and both are worth seeing.
 */

const ACTIVITY = Object.freeze({
  ACTIVE: 'active',
  SILENT: 'silent',
});

const LABELS = Object.freeze(Object.fromEntries(
  DETECTABLE_AGENTS.map(agent => [agent.profile, agent.label]),
));

function installedAtOf(target, installed) {
  if (!installed || !target) return null;
  try {
    return new Date(fs.statSync(target).mtimeMs).toISOString();
  } catch (_) {
    return null;
  }
}

function foldIdentities(identities) {
  const byDecision = {};
  let actions = 0;
  let lastInvocationAt = null;
  for (const identity of identities) {
    actions += identity.actions;
    for (const [decision, count] of Object.entries(identity.byDecision)) {
      byDecision[decision] = (byDecision[decision] || 0) + count;
    }
    const at = identity.lastAt;
    if (at && (lastInvocationAt === null || at > lastInvocationAt)) lastInvocationAt = at;
  }
  return { actions, byDecision, lastInvocationAt };
}

function row(base, identities) {
  const folded = foldIdentities(identities);
  return {
    ...base,
    ...folded,
    // Says whether anything has come through, never why not.
    activity: folded.actions > 0 ? ACTIVITY.ACTIVE : ACTIVITY.SILENT,
    identities: identities.map(identity => ({
      identityRef: identity.identityRef,
      attestation: identity.attestation,
      nameCollision: identity.nameCollision,
      actions: identity.actions,
      lastAt: identity.lastAt,
      workspaces: identity.workspaces,
    })),
  };
}

/**
 * @param {object} [options]
 * @param {string} [options.root] project directory, for gate status
 * @param {string} [options.home] home directory, for gate status
 * @param {string} [options.receiptPath] receipt trail to read
 * @param {string} [options.workspaceId] narrow the roster to one workspace
 */
function buildAgentOverview(options = {}) {
  const status = manageGate('status', {
    deploymentAuthorized: true,
    root: options.root,
    home: options.home,
    receiptPath: options.receiptPath,
  });
  const receiptPath = options.receiptPath || status.custom?.receiptPath || null;
  const roster = buildAgentRoster(receiptPath, { workspaceId: options.workspaceId });

  const claimed = new Set();
  const agents = [];

  for (const client of status.clients) {
    // A profile's invocations carry its own name as the agent name, verified
    // against a live codex receipt: agentName === agentId === the profile.
    const identities = roster.agents.filter(agent => agent.agentName === client.profile);
    for (const identity of identities) claimed.add(identity.identityRef);
    agents.push(row({
      kind: 'profile',
      profile: client.profile,
      label: LABELS[client.profile] || client.profile,
      connected: client.installed === true,
      target: client.target,
      installedAt: installedAtOf(client.target, client.installed),
    }, identities));
  }

  for (const identity of roster.agents) {
    if (claimed.has(identity.identityRef)) continue;
    agents.push(row({
      kind: 'custom',
      profile: null,
      label: identity.agentName,
      // Not false: there is no artifact to inspect for a custom agent, so
      // whether it is connected is unknowable, not known to be no (#2048).
      connected: null,
      target: null,
      installedAt: null,
    }, [identity]));
  }

  agents.sort((left, right) => String(right.lastInvocationAt || '').localeCompare(String(left.lastInvocationAt || ''))
    || String(left.label).localeCompare(String(right.label)));

  return {
    ok: roster.ok !== false,
    receiptPath,
    connected: agents.filter(agent => agent.connected === true).length,
    acting: agents.filter(agent => agent.activity === ACTIVITY.ACTIVE).length,
    agents,
  };
}

module.exports = {
  AGENT_ACTIVITY: ACTIVITY,
  OVERVIEW_PROFILES: PROFILES,
  buildAgentOverview,
};

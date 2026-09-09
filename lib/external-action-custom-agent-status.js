'use strict';

const fs = require('node:fs');
const {
  parseExternalActionReceiptLines,
  externalActionReceiptIdentity,
} = require('./external-action-identity-log');

/**
 * Gate status for an agent HUQAN cannot inspect (#2048).
 *
 * The five installable profiles are answered by looking at the artifact that
 * was written and re-running a sentinel through it. A custom agent has no such
 * artifact: HUQAN does not know where its configuration lives, or whether it
 * has one. The only thing HUQAN can honestly speak to is its own receipt
 * trail -- whether an envelope ever arrived.
 *
 * Two states are derivable and no more:
 *
 *   no-invocation      no envelope has ever arrived from this agent, so it is
 *                      definitively not calling HUQAN;
 *   envelope-observed  envelopes arrived, so the call path is live.
 *
 * The state a connect flow would most like to report -- "the envelope arrives
 * but is not wired to the real executor" -- is NOT derivable, because nothing
 * tells HUQAN whether the agent ran the command anyway after a block. Reporting
 * it would be the same fake green as #1792/#1797: a gate that looked installed
 * while the wrong thing was being measured.
 */

const STATES = Object.freeze({
  UNREADABLE: 'unreadable',
  NO_INVOCATION: 'no-invocation',
  ENVELOPE_OBSERVED: 'envelope-observed',
});

const OBSERVATION_LIMIT = 'An observed envelope proves the agent called HUQAN. '
  + 'It does not prove the agent honoured the decision: nothing reports back whether '
  + 'the command ran anyway after a block.';

function agentNameOf(receipt) {
  const identity = externalActionReceiptIdentity(receipt);
  return String(identity.agentName || identity.agentId || receipt.actor || '').trim();
}

function readReceiptLines(receiptPath) {
  try {
    return { ok: true, raw: fs.readFileSync(receiptPath, 'utf8') };
  } catch (error) {
    // A trail that was never written is not an error: it is the strongest
    // evidence that nothing ever called the gate.
    if (error && error.code === 'ENOENT') return { ok: true, raw: '' };
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

/**
 * @param {string} receiptPath external action receipt trail to read
 * @param {object} [options]
 * @param {string[]} [options.knownProfiles] profile names answered by artifact
 *   inspection instead; their invocations are excluded, so a running Codex gate
 *   is never counted as evidence that a custom agent is connected.
 * @param {string} [options.agentName] narrow to a single agent name
 */
function customAgentGateStatus(receiptPath, options = {}) {
  const knownProfiles = new Set(options.knownProfiles || []);
  const wanted = String(options.agentName || '').trim();
  const source = readReceiptLines(receiptPath);
  if (!source.ok) {
    return {
      profile: 'generic',
      receiptPath,
      agentName: wanted || null,
      state: STATES.UNREADABLE,
      error: source.error,
      observationLimit: OBSERVATION_LIMIT,
    };
  }

  const { receipts, skipped } = parseExternalActionReceiptLines(source.raw);
  const matched = [];
  for (const receipt of receipts) {
    const name = agentNameOf(receipt);
    if (!name) continue;
    if (wanted ? name !== wanted : knownProfiles.has(name)) continue;
    matched.push({ receipt, name });
  }

  const byDecision = {};
  let lastInvocationAt = null;
  const agents = new Set();
  for (const entry of matched) {
    const decision = String(entry.receipt.decision || 'unknown');
    byDecision[decision] = (byDecision[decision] || 0) + 1;
    agents.add(entry.name);
    const at = String(entry.receipt.createdAt || '');
    if (at && (lastInvocationAt === null || at > lastInvocationAt)) lastInvocationAt = at;
  }

  return {
    profile: 'generic',
    receiptPath,
    agentName: wanted || null,
    // Deliberately no `installed` field: there is no artifact to inspect, and
    // reporting `false` would read as "not installed" rather than "unknowable".
    state: matched.length > 0 ? STATES.ENVELOPE_OBSERVED : STATES.NO_INVOCATION,
    invocations: matched.length,
    lastInvocationAt,
    byDecision,
    agents: [...agents].sort(),
    skippedLines: skipped,
    observationLimit: OBSERVATION_LIMIT,
  };
}

module.exports = {
  CUSTOM_AGENT_GATE_STATES: STATES,
  CUSTOM_AGENT_OBSERVATION_LIMIT: OBSERVATION_LIMIT,
  customAgentGateStatus,
};

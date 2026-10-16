'use strict';

const fs = require('node:fs');
const {
  parseExternalActionReceiptLines,
  externalActionReceiptIdentity,
} = require('./external-action-identity-log');

/**
 * Which agents have acted, and what they did (#2052).
 *
 * queryExternalActionsByIdentity() answers "what did *this* identity do" -- you
 * have to know the identity before you can ask. A monitoring view has to start
 * from the other end: here is everything that has acted through this gate.
 *
 * Rows are keyed by identityRef, never by agentName. An unattested name is a
 * claim the envelope carried, and lib/external-action-identity.js records it
 * with `attested: false` and an `unattested` owner exactly so a reader cannot
 * mistake it for a verified one. Two different identities may claim the same
 * name; merging them by name would let one agent's record absorb another's,
 * which is the failure a monitoring view exists to prevent. Collisions are
 * reported (`nameCollision`) rather than resolved.
 *
 * Attestation is per identity and may be `mixed`: the same identityRef can
 * have acted both with and without a valid capability card, and averaging that
 * into one boolean would hide the unattested half.
 */

const ATTESTATION = Object.freeze({
  ATTESTED: 'attested',
  UNATTESTED: 'unattested',
  MIXED: 'mixed',
});

function bump(counter, key) {
  if (!key) return;
  counter[key] = (counter[key] || 0) + 1;
}

function attestationOf(attested, unattested) {
  if (attested > 0 && unattested > 0) return ATTESTATION.MIXED;
  return attested > 0 ? ATTESTATION.ATTESTED : ATTESTATION.UNATTESTED;
}

function readTrail(receiptPath) {
  try {
    return { ok: true, raw: fs.readFileSync(receiptPath, 'utf8') };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, raw: '' };
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

/**
 * @param {string} receiptPath external action receipt trail
 * @param {object} [options]
 * @param {string} [options.workspaceId] narrow to one workspace
 * @param {string} [options.since] ISO lower bound, inclusive
 */
function buildAgentRoster(receiptPath, options = {}) {
  const source = readTrail(receiptPath);
  if (!source.ok) {
    return { ok: false, receiptPath, error: source.error, agents: [] };
  }

  const { receipts, skipped } = parseExternalActionReceiptLines(source.raw);
  const wantedWorkspace = String(options.workspaceId || '').trim();
  const since = String(options.since || '').trim();
  const rows = new Map();

  for (const receipt of receipts) {
    const identity = externalActionReceiptIdentity(receipt);
    const identityRef = String(identity.identityRef || '').trim();
    // No identityRef means the receipt cannot be attributed to anyone. It is
    // counted as unattributed rather than filed under a guessed name.
    if (!identityRef) continue;
    const workspaceId = String(identity.workspaceId || receipt.workspaceId || 'default');
    if (wantedWorkspace && workspaceId !== wantedWorkspace) continue;
    const at = String(receipt.createdAt || '');
    if (since && (!at || at < since)) continue;

    let row = rows.get(identityRef);
    if (!row) {
      row = {
        identityRef,
        agentId: String(identity.agentId || ''),
        agentName: String(identity.agentName || identity.agentId || ''),
        workspaces: new Set(),
        owners: new Set(),
        sessions: new Set(),
        attestedActions: 0,
        unattestedActions: 0,
        actions: 0,
        byDecision: {},
        byToolKind: {},
        firstAt: null,
        lastAt: null,
      };
      rows.set(identityRef, row);
    }

    row.actions += 1;
    if (identity.attested) row.attestedActions += 1; else row.unattestedActions += 1;
    row.workspaces.add(workspaceId);
    if (identity.ownerActorId) row.owners.add(String(identity.ownerActorId));
    if (identity.sessionId) row.sessions.add(String(identity.sessionId));
    bump(row.byDecision, receipt.decision);
    bump(row.byToolKind, receipt.metadata?.toolKind);
    if (at && (row.firstAt === null || at < row.firstAt)) row.firstAt = at;
    if (at && (row.lastAt === null || at > row.lastAt)) row.lastAt = at;
  }

  const nameCounts = {};
  for (const row of rows.values()) bump(nameCounts, row.agentName);

  const agents = [...rows.values()]
    .map(row => ({
      identityRef: row.identityRef,
      agentId: row.agentId,
      agentName: row.agentName,
      // True when another identity claims this same name. Surfaced so the view
      // can show both rows as distinct instead of implying one agent.
      nameCollision: nameCounts[row.agentName] > 1,
      attestation: attestationOf(row.attestedActions, row.unattestedActions),
      attestedActions: row.attestedActions,
      unattestedActions: row.unattestedActions,
      actions: row.actions,
      byDecision: row.byDecision,
      byToolKind: row.byToolKind,
      workspaces: [...row.workspaces].sort(),
      owners: [...row.owners].sort(),
      sessions: row.sessions.size,
      firstAt: row.firstAt,
      lastAt: row.lastAt,
    }))
    .sort((left, right) => String(right.lastAt || '').localeCompare(String(left.lastAt || ''))
      || left.identityRef.localeCompare(right.identityRef));

  return {
    ok: true,
    receiptPath,
    scanned: receipts.length,
    skippedLines: skipped,
    agents,
  };
}

module.exports = {
  AGENT_ATTESTATION: ATTESTATION,
  buildAgentRoster,
};

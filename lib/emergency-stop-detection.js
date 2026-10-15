'use strict';

// Emergency-stop detection against the approval authority's ledger (#3892,
// ADR-016 "Recording a stop"). compareStopsWithAuthority is a pure data
// comparison for `huqan audit --authority`: both ledgers arrive as arguments.
//
// Two bypasses a same-user agent can make in the local ledger alone, because
// it can rewrite that file into a chain that still verifies:
//
// - a stop that disappears. Every stop the runtime made in service mode was
//   reported to the authority with its local entry hash, so a recorded hash
//   that the local ledger no longer holds is a stop someone removed;
// - a lift nobody decided. In service mode every lift needs a consumed
//   authority decision for its exact scope, so more local lifts of a scope
//   than consumed lift decisions for it is a lift written past the guard.

const { emergencyStopLedger } = require('./emergency-stop');
const { readLedgerEntries } = require('./emergency-stop-chain');

const EMERGENCY_STOP_TOOL = 'huqan.emergency_stop';

function scopeKeyOf(scope, workspaceId, agentId) {
  return `${scope}|${workspaceId}|${agentId || ''}`;
}

function missingStops(authorityEntries, localEntries, workspaceId) {
  const localHashes = new Set(localEntries.map(entry => entry.hash));
  const findings = [];
  for (const entry of authorityEntries) {
    const body = entry && entry.body;
    if (!entry || entry.type !== 'emergency.stopped' || !body || body.workspaceId !== workspaceId) continue;
    if (!localHashes.has(body.localHash)) {
      findings.push({ code: 'STOP_MISSING_LOCALLY', scope: body.scope, agentId: body.agentId || null,
        localSeq: body.localSeq, localHash: body.localHash, ledgerSeq: entry.seq });
    }
  }
  return findings;
}

function consumedLiftsByScope(authorityEntries, workspaceId) {
  const liftScope = new Map();
  const counts = new Map();
  for (const entry of authorityEntries) {
    const body = entry && entry.body;
    if (!entry || !body || typeof body.approvalId !== 'string') continue;
    const args = body.arguments;
    if (entry.type === 'approval.registered' && body.tool === EMERGENCY_STOP_TOOL && body.workspaceId === workspaceId
      && args && args.action === 'lift') {
      liftScope.set(body.approvalId, scopeKeyOf(args.scope, args.workspaceId, args.agentId));
    } else if (entry.type === 'approval.consumed' && liftScope.has(body.approvalId)) {
      const key = liftScope.get(body.approvalId);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}

function undecidedLifts(authorityEntries, localEntries, workspaceId) {
  // Lifts before the authority's first entry predate it and needed no decision.
  const since = Date.parse(authorityEntries[0].at);
  if (!Number.isFinite(since)) return [];
  const consumed = consumedLiftsByScope(authorityEntries, workspaceId);
  const local = new Map();
  for (const entry of localEntries) {
    if (entry.action !== 'lift' || entry.workspaceId !== workspaceId || !(Date.parse(entry.createdAt) >= since)) continue;
    const key = scopeKeyOf(entry.scope, entry.workspaceId, entry.agentId);
    local.set(key, (local.get(key) || 0) + 1);
  }
  const findings = [];
  for (const [key, count] of local) {
    const decided = consumed.get(key) || 0;
    if (count > decided) {
      const [scope, , agentId] = key.split('|');
      findings.push({ code: 'LIFT_WITHOUT_AUTHORITY', scope, agentId: agentId || null, localLifts: count, consumedLifts: decided });
    }
  }
  return findings;
}

/**
 * @param {object} input
 * @param {object[]} input.authorityEntries the fetched authority ledger window
 * @param {object[]|null} input.localEntries the local emergency-stop ledger entries, or null when unreadable
 * @param {string} input.workspaceId
 * @param {boolean} input.truncated whether the authority window starts after its genesis
 * @returns {object[]} findings, empty when both ledgers agree
 */
function compareStopsWithAuthority({ authorityEntries, localEntries, workspaceId, truncated }) {
  const entries = Array.isArray(authorityEntries) ? authorityEntries : [];
  const relevant = entries.some(entry => entry && entry.body && (entry.type === 'emergency.stopped'
    || (entry.type === 'approval.registered' && entry.body.tool === EMERGENCY_STOP_TOOL
      && entry.body.arguments && entry.body.arguments.action === 'lift')));
  const localReadable = Array.isArray(localEntries)
    && !localEntries.some(entry => !entry || entry.__unreadable || entry.__corrupt);
  // A cut window may hold a lift's consumption but not its registration, so
  // counting lifts is only sound against the whole authority ledger.
  const canCompareLifts = !truncated && entries.length > 0 && Boolean(entries[0])
    && Number.isFinite(Date.parse(entries[0].at));
  // A window with no stop records still covers a lift: one of a stop made
  // before the authority was installed needs a decision too. Only an
  // unreadable local ledger with nothing about stops in the window is no finding.
  if (!relevant && (!canCompareLifts || !localReadable)) return [];
  if (!localReadable) {
    return [{ code: 'LOCAL_STOP_LEDGER_UNREADABLE', detail: 'the local emergency-stop ledger could not be compared' }];
  }
  const findings = missingStops(entries, localEntries, workspaceId);
  if (canCompareLifts) findings.push(...undecidedLifts(entries, localEntries, workspaceId));
  return findings;
}

/** The configured local emergency-stop ledger, or null when it cannot be read (audit reports that). */
function readLocalStopEntries(options = {}) {
  try {
    return readLedgerEntries(emergencyStopLedger(options).directory);
  } catch (_) {
    return null;
  }
}

module.exports = { compareStopsWithAuthority, readLocalStopEntries };

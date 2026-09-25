'use strict';

// #2505 implementation order, step 2 (first foundation): the impact budget
// ledger. Pure exposure accounting with no policy inside: callers reserve
// impact units before execution, commit on admission, and release on
// confirmed non-execution. Thresholds, bands and verdicts live in the gate
// (and, for now, only in the replay script); this module only adds.
//
// Durability reuses the existing mutation journal authority
// (`Graph.runMutationOnce`), like the sandbox-escape and trust-evidence
// ledgers: no second table, signer, or receipt family. Journal rows carry
// the state (not chain receipts), so there is no receipt-family or V4
// interaction. Duplicate idempotency keys return the prior result without
// double charge, by the platform's own replay. Concurrent children share one
// durable root because every mutation funnels through the same journal;
// Node runs each mutation callback to completion before the next begins.
//
// Crash recovery is structural: state is derived from committed rows on
// every read, so reopening the store resumes exactly where it stopped.
// Committing or releasing an unknown reservation throws (caller bug,
// fail-closed); recording itself never invents scope.

const BUDGET_OPERATION_PREFIX = 'impact-budget:';
const BUDGET_POLICY_VERSION = 'huqan-impact-budget-v1';
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const MAX_SCOPE_FIELD_LENGTH = 256;

function text(value, field, { max = MAX_SCOPE_FIELD_LENGTH } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${field} exceeds bounded length`);
  return normalized;
}

function amount(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a finite number at or above 0`);
  }
  return value;
}

function normalizeScope(scope = {}) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new TypeError('scope must be an object');
  }
  return Object.freeze({
    policyVersion: text(scope.policyVersion, 'scope.policyVersion', { max: 64 }),
    workspaceId: text(scope.workspaceId, 'scope.workspaceId'),
    runId: scope.runId === undefined || scope.runId === null ? null : text(scope.runId, 'scope.runId'),
    sessionId: scope.sessionId === undefined || scope.sessionId === null
      ? null
      : text(scope.sessionId, 'scope.sessionId'),
  });
}

function key(scope) {
  return `${scope.policyVersion}\0${scope.workspaceId}\0${scope.runId || ''}\0${scope.sessionId || ''}`;
}

function idempotencyKey(value, field) {
  return text(value, field, { max: MAX_IDEMPOTENCY_KEY_LENGTH });
}

function requireGraph(graph) {
  if (!graph || typeof graph.runMutationOnce !== 'function'
    || typeof graph.getCommittedMutationResultsByPrefix !== 'function') {
    throw new TypeError('graph with runMutationOnce and prefix reads is required');
  }
  return graph;
}

function readBudgetRows(graph) {
  let rows = [];
  try {
    rows = graph.getCommittedMutationResultsByPrefix(BUDGET_OPERATION_PREFIX);
  } catch (_) {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => row && row.result && row.result.budget === true);
}

/**
 * Derive per-scope { reserved, committed } from committed rows. Released and
 * committed amounts leave the reserved pool; a reservation counts once no
 * matter how often its key replays, because replays never write a new row.
 */
function readBudgetState(graph, scope) {
  requireGraph(graph);
  const wanted = normalizeScope(scope);
  const want = key(wanted);
  let reserved = 0;
  let committed = 0;
  const seenReservations = new Set();
  for (const row of readBudgetRows(graph)) {
    const result = row.result;
    let rowScope = null;
    try {
      rowScope = normalizeScope(result.scope);
    } catch (_) {
      continue;
    }
    if (key(rowScope) !== want) continue;
    if (result.kind === 'reserve' && typeof result.reservationId === 'string' && !seenReservations.has(result.reservationId)) {
      seenReservations.add(result.reservationId);
      reserved += result.amount;
    } else if ((result.kind === 'commit' || result.kind === 'release') && typeof result.reservationId === 'string' && !seenReservations.has(`settled:${result.reservationId}`)) {
      seenReservations.add(`settled:${result.reservationId}`);
      reserved -= result.amount;
      if (result.kind === 'commit') committed += result.amount;
    }
  }
  return Object.freeze({ scope: wanted, reserved: Math.max(0, reserved), committed: Math.max(0, committed) });
}

function reserveImpact(graph, { scope, amount: units, idempotencyKey: keyText, actionDigest = null } = {}) {
  requireGraph(graph);
  const settledScope = normalizeScope(scope);
  const value = amount(units, 'amount');
  const keyId = idempotencyKey(keyText, 'idempotencyKey');
  const digest = actionDigest === undefined || actionDigest === null ? null : text(actionDigest, 'actionDigest', { max: 128 });
  const reservationId = `res:${keyId}`;
  const outcome = graph.runMutationOnce(
    `${BUDGET_OPERATION_PREFIX}reserve:${keyId}`,
    () => ({
      budget: true,
      ledgerVersion: BUDGET_POLICY_VERSION,
      kind: 'reserve',
      scope: settledScope,
      amount: value,
      reservationId,
      actionDigest: digest,
    }),
  );
  const state = readBudgetState(graph, settledScope);
  return Object.freeze({
    replayed: Boolean(outcome.replayed),
    reservationId,
    reserved: state.reserved,
    committed: state.committed,
  });
}

function settleReservation(graph, kind, { reservationId, idempotencyKey: keyText } = {}) {
  requireGraph(graph);
  if (kind !== 'commit' && kind !== 'release') throw new TypeError('kind must be commit or release');
  const id = typeof reservationId === 'string' && reservationId.trim() ? reservationId.trim() : null;
  if (!id) throw new TypeError('reservationId is required');
  const keyId = idempotencyKey(keyText, 'idempotencyKey');
  const rows = readBudgetRows(graph);
  // Replay first: the platform replays the same operation id, but the
  // already-settled guard below must not fire on a legitimate replay.
  const settledOpId = `${BUDGET_OPERATION_PREFIX}${kind}:${keyId}`;
  if (rows.some((row) => row.operationId === settledOpId)) {
    return Object.freeze({ replayed: true, reservationId: id, kind });
  }
  const reservation = rows.find((row) => row.result
    && row.result.kind === 'reserve' && row.result.reservationId === id);
  // The reservation row must exist: settling thin air is a caller bug, and a
  // quiet no-op would let a gate believe budget moved when nothing did.
  if (!reservation) throw new Error(`unknown reservation: ${id}`);
  const alreadySettled = rows.some((row) => row.result
    && (row.result.kind === 'commit' || row.result.kind === 'release') && row.result.reservationId === id);
  if (alreadySettled) throw new Error(`reservation already settled: ${id}`);
  const outcome = graph.runMutationOnce(
    `${BUDGET_OPERATION_PREFIX}${kind}:${keyId}`,
    () => ({
      budget: true, ledgerVersion: BUDGET_POLICY_VERSION, kind, reservationId: id, amount: reservation.result.amount, scope: reservation.result.scope,
    }),
  );
  return Object.freeze({ replayed: Boolean(outcome.replayed), reservationId: id, kind });
}

function commitReservation(graph, input = {}) {
  return settleReservation(graph, 'commit', input);
}

function releaseReservation(graph, input = {}) {
  return settleReservation(graph, 'release', input);
}

function checkBand(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a finite number at or above 0`);
  }
  return value;
}

/**
 * #2505 A: project what a proposed action would do to a budget scope.
 * Pure decision support: given a readBudgetState result, a proposed amount
 * and explicit bands, return the projected total (committed + reserved +
 * proposed) with the band it lands in. Equality triggers the band. Bands
 * arrive as arguments and have no defaults, so no policy hides here; the
 * gate that enforces them is a separate, owner-approved slice.
 */
function projectBudgetVerdict(budgetState, proposedAmount, bands = {}) {
  if (!budgetState || typeof budgetState !== 'object' || Array.isArray(budgetState)) {
    throw new TypeError('budgetState must be a readBudgetState result');
  }
  const reserved = budgetState.reserved;
  const committed = budgetState.committed;
  if (typeof reserved !== 'number' || !Number.isFinite(reserved) || reserved < 0
    || typeof committed !== 'number' || !Number.isFinite(committed) || committed < 0) {
    throw new TypeError('budgetState must carry finite reserved and committed totals');
  }
  const proposed = amount(proposedAmount, 'proposedAmount');
  if (!bands || typeof bands !== 'object' || Array.isArray(bands)) {
    throw new TypeError('bands must be an object');
  }
  const reviewAt = checkBand(bands.reviewAt, 'bands.reviewAt');
  const quorumAt = checkBand(bands.quorumAt, 'bands.quorumAt');
  const blockAt = checkBand(bands.blockAt, 'bands.blockAt');
  if (!(reviewAt <= quorumAt && quorumAt <= blockAt)) {
    throw new TypeError('bands must order reviewAt <= quorumAt <= blockAt');
  }
  const projected = committed + reserved + proposed;
  const verdict = projected >= blockAt ? 'block'
    : projected >= quorumAt ? 'quorum'
    : projected >= reviewAt ? 'review'
    : 'allow';
  return Object.freeze({
    projected,
    verdict,
    bands: Object.freeze({ reviewAt, quorumAt, blockAt }),
  });
}

module.exports = {
  BUDGET_OPERATION_PREFIX,
  BUDGET_POLICY_VERSION,
  readBudgetState,
  reserveImpact,
  commitReservation,
  releaseReservation,
  projectBudgetVerdict,
};

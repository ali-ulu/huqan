'use strict';

/**
 * COG-C (#4393, PR-2): the durable, workspace-bound conversation store.
 *
 * This is the production caller the pure `lib/cognition/conversation-turn.js`
 * contract was shipped ahead of. One conversation turn is persisted as an
 * append-only journal operation under its own `conversation:` prefix -- the
 * single persistence authority (plan invariant 2), so there is no second store
 * to keep consistent -- and the same workspace's history is read back for the
 * planner.
 *
 * Invariant 9 is why raw message text never reaches the journal: a row carries
 * the content *digest* and its *length*, never the body, and a record is only
 * written when the caller has already decided a retention policy for it. A
 * deleted message is tombstoned rather than unlinked, and the reader excludes
 * it, so a deleted source cannot be recalled by a later replay.
 *
 * Pure Core ring: no clock of its own (the caller supplies `at`), no I/O beyond
 * the injected graph, no randomness. The store never decides admission and
 * never plans a turn; it records what the caller has already admitted and reads
 * back what the planner is allowed to see.
 */

const { isPlainObject } = require('./is-plain-object');
const { planConversationTurn } = require('./cognition/conversation-turn');

const TURN_PREFIX = 'conversation:turn:';
const TOMBSTONE_PREFIX = 'conversation:tombstone:';
const STORE_VERSION = 'huqan-conversation-store-v1';
const MAX_ID_LENGTH = 256;
// The journal refuses a prefix read over 512 characters, so a scope whose
// *encoded* tombstone prefix (the longer of the two) would exceed that bound is
// unusable: turns could be written but never read back. Checked on the encoded
// length, not the raw one, because the prefix percent-encodes both ids.
const PREFIX_READ_MAX = 512;
const MAX_HISTORY_TURNS = 200;
const RETENTION_MODES = Object.freeze(['none', 'conversation']);

// oxlint-disable-next-line no-control-regex -- deliberate: an identifier may not carry control characters
const CONTROL_CHARS = /[\x00-\x1F\x7F]/;

function identifier(value, field) {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError(`${field} must be a non-empty string`);
  if (trimmed.length > MAX_ID_LENGTH) throw new TypeError(`${field} must be at most ${MAX_ID_LENGTH} characters`);
  if (CONTROL_CHARS.test(trimmed)) throw new TypeError(`${field} must not contain control characters`);
  return trimmed;
}

function count(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer`);
  return value;
}

function digest(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new TypeError('contentDigest must be a sha256 hex digest');
  return value;
}

function requireGraph(graph) {
  if (!graph || typeof graph.runMutationOnce !== 'function'
    || typeof graph.getCommittedMutationResultsByPrefix !== 'function') {
    throw new TypeError('graph with runMutationOnce and prefix reads is required');
  }
  return graph;
}

const segment = (value) => encodeURIComponent(value);
const turnOperationId = (scope, messageId) => `${TURN_PREFIX}${segment(scope.workspaceId)}/${segment(scope.conversationId)}/${segment(messageId)}`;
const tombstoneOperationId = (scope, messageId) => `${TOMBSTONE_PREFIX}${segment(scope.workspaceId)}/${segment(scope.conversationId)}/${segment(messageId)}`;
const conversationPrefix = (scope) => `${TURN_PREFIX}${segment(scope.workspaceId)}/${segment(scope.conversationId)}/`;
const tombstonePrefix = (scope) => `${TOMBSTONE_PREFIX}${segment(scope.workspaceId)}/${segment(scope.conversationId)}/`;

// A failed prefix read must not read as "no rows": an empty list would show a
// tombstoned turn again and report an empty history as success. The error is
// left to propagate so the caller fails closed instead of serving partial data.
function readRows(graph, prefix) {
  const rows = graph.getCommittedMutationResultsByPrefix(prefix);
  return Array.isArray(rows) ? rows.filter((row) => row && isPlainObject(row.result)) : [];
}

function normalizeScope(input = {}) {
  const scope = {
    workspaceId: identifier(input.workspaceId, 'workspaceId'),
    conversationId: identifier(input.conversationId, 'conversationId'),
  };
  if (tombstonePrefix(scope).length > PREFIX_READ_MAX) {
    const error = new TypeError('workspaceId and conversationId are too long for this conversation scope');
    error.code = 'INVALID_CONVERSATION_SCOPE';
    throw error;
  }
  return scope;
}

function normalizeRetention(value) {
  if (value === undefined || value === null) return 'conversation';
  if (!RETENTION_MODES.includes(value)) throw new TypeError(`retention must be one of ${RETENTION_MODES.join(', ')}`);
  return value;
}

/**
 * Append one conversation turn. The same messageId replays its record; a
 * different payload for the same messageId fails closed. With retention
 * `none` nothing is written at all -- a caller that asked not to keep the
 * turn opens no record for it.
 *
 * @returns {{stored: boolean, replayed: boolean, record: object|null, reason?: string}}
 */
function appendConversationTurn(graph, input = {}) {
  requireGraph(graph);
  const scope = normalizeScope(input);
  const messageId = identifier(input.messageId, 'messageId');
  const sessionId = identifier(input.sessionId, 'sessionId');
  const sequence = count(input.sequence, 'sequence');
  const contentDigest = digest(input.contentDigest);
  const contentChars = count(input.contentChars, 'contentChars');
  const sourceLabel = identifier(input.sourceLabel, 'sourceLabel');
  const admissionId = identifier(input.admissionId, 'admissionId');
  const retention = normalizeRetention(input.retention);
  const operationId = turnOperationId(scope, messageId);

  const record = {
    conversationTurn: true,
    storeVersion: STORE_VERSION,
    workspaceId: scope.workspaceId,
    conversationId: scope.conversationId,
    sessionId,
    messageId,
    sequence,
    contentDigest,
    contentChars,
    sourceLabel,
    admissionId,
    replyToMessageId: input.replyToMessageId === undefined || input.replyToMessageId === null ? null : identifier(input.replyToMessageId, 'replyToMessageId'),
    decisionRef: input.decisionRef === undefined || input.decisionRef === null ? null : identifier(input.decisionRef, 'decisionRef'),
    repairRef: input.repairRef === undefined || input.repairRef === null ? null : identifier(input.repairRef, 'repairRef'),
    ...(input.reportedFeeling ? { reportedFeeling: input.reportedFeeling } : {}),
    at: input.at === undefined || input.at === null ? null : identifier(input.at, 'at'),
  };

  // A tombstoned messageId is a deleted message: it may not be written again,
  // even as a replay, or it would be stored yet never recalled by GET or
  // planning. Checked before the prior-row replay so a deleted turn cannot be
  // resurrected by a retry.
  const tombstoneId = tombstoneOperationId(scope, messageId);
  if (readRows(graph, tombstoneId).some((row) => row.operationId === tombstoneId)) {
    throw new TypeError(`message ${messageId} was deleted and cannot be re-recorded`);
  }

  const prior = readRows(graph, operationId).find((row) => row.operationId === operationId);
  if (prior) {
    if (!isSameTurn(prior.result, record)) throw new TypeError(`message ${messageId} already recorded with a different payload`);
    return { stored: false, replayed: true, record: prior.result };
  }

  if (retention === 'none') return { stored: false, replayed: false, record: null, reason: 'retention_disabled' };

  // The prior-row check above runs before the lock, so a concurrent writer can
  // win the same operationId first. Its committed result is the authority: a
  // replay must match this payload, and a mismatch fails closed rather than
  // reporting the winner's record as this caller's success.
  const outcome = graph.runMutationOnce(operationId, () => record);
  if (outcome && outcome.replayed) {
    if (!isSameTurn(outcome.result, record)) throw new TypeError(`message ${messageId} already recorded with a different payload`);
    return { stored: false, replayed: true, record: outcome.result };
  }
  return { stored: true, replayed: false, record };
}

/**
 * Two records are the same turn only when every field the caller controls
 * matches. A retry that changes sessionId, reply-to, or a reference is a
 * different payload, not a replay, so it must fail closed rather than silently
 * keeping the stored values.
 */
function isSameTurn(stored, record) {
  return isPlainObject(stored)
    && stored.storeVersion === STORE_VERSION
    && stored.workspaceId === record.workspaceId
    && stored.conversationId === record.conversationId
    && stored.messageId === record.messageId
    && stored.sessionId === record.sessionId
    && stored.sequence === record.sequence
    && stored.contentDigest === record.contentDigest
    && stored.contentChars === record.contentChars
    && stored.sourceLabel === record.sourceLabel
    && stored.replyToMessageId === record.replyToMessageId
    && stored.decisionRef === record.decisionRef
    && stored.repairRef === record.repairRef
    && JSON.stringify(stored.reportedFeeling || null) === JSON.stringify(record.reportedFeeling || null);
}

/**
 * Read the admitted, non-deleted turns of one conversation in one workspace.
 * Rows from another workspace, another store version, or a tombstoned
 * messageId are never returned. `content` is intentionally absent: only the
 * digest and length exist, so the planner cannot treat the body as data it can
 * echo back. The newest `limit` turns are returned, oldest first, so a long
 * conversation cannot grow the read (or its response) without bound.
 */
function readConversationHistory(graph, input = {}) {
  requireGraph(graph);
  const scope = normalizeScope(input);
  const limit = input.limit === undefined ? MAX_HISTORY_TURNS : count(input.limit, 'limit');
  const deleted = new Set(
    readRows(graph, tombstonePrefix(scope))
      .filter((row) => row.result.conversationTombstone === true && row.result.storeVersion === STORE_VERSION)
      .map((row) => row.result.messageId),
  );
  const admitted = readRows(graph, conversationPrefix(scope))
    .filter((row) => row.result.conversationTurn === true
      && row.result.storeVersion === STORE_VERSION
      && row.result.workspaceId === scope.workspaceId
      && row.result.conversationId === scope.conversationId)
    .filter((row) => !deleted.has(row.result.messageId))
    .map((row) => row.result)
    .sort((a, b) => (a.sequence - b.sequence) || (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0));
  if (limit === 0) return [];
  return admitted.length > limit ? admitted.slice(admitted.length - limit) : admitted;
}

/**
 * Tombstone one message so it is never recalled again. Idempotent: the same
 * target replays its tombstone.
 *
 * @returns {{deleted: boolean, replayed: boolean}}
 */
function deleteConversationMessage(graph, input = {}) {
  requireGraph(graph);
  const scope = normalizeScope(input);
  const messageId = identifier(input.messageId, 'messageId');
  const operationId = tombstoneOperationId(scope, messageId);
  const prior = readRows(graph, operationId).find((row) => row.operationId === operationId);
  if (prior) return { deleted: true, replayed: true };
  graph.runMutationOnce(operationId, () => ({
    conversationTombstone: true,
    storeVersion: STORE_VERSION,
    workspaceId: scope.workspaceId,
    conversationId: scope.conversationId,
    messageId,
    at: input.at === undefined || input.at === null ? null : identifier(input.at, 'at'),
  }));
  return { deleted: true, replayed: false };
}

/**
 * Plan one turn against this conversation's admitted history. The store owns
 * both the history read and the plan so the caller (Platform) consumes one
 * published Memory port and never reaches into `lib/cognition` itself.
 *
 * @returns {Readonly<object>} the pure contract's plan
 */
function planConversationTurnFromStore(graph, input = {}) {
  requireGraph(graph);
  const scope = normalizeScope(input);
  const messageId = identifier(input.messageId, 'messageId');
  const history = readConversationHistory(graph, scope)
    .filter((row) => row.messageId !== messageId)
    .map((row) => ({
      conversationId: row.conversationId,
      sessionId: row.sessionId,
      workspaceId: row.workspaceId,
      messageId: row.messageId,
      sequence: row.sequence,
      contentChars: row.contentChars,
      sourceLabel: row.sourceLabel,
      admissionId: row.admissionId,
    }));
  return planConversationTurn({ workspaceId: scope.workspaceId, turn: input.turn, history });
}

module.exports = Object.freeze({
  STORE_VERSION,
  TURN_PREFIX,
  TOMBSTONE_PREFIX,
  RETENTION_MODES,
  appendConversationTurn,
  readConversationHistory,
  deleteConversationMessage,
  planConversationTurnFromStore,
});

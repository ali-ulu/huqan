'use strict';

/**
 * COG-C (#4393, PR-1): pure, deterministic contract for one conversation turn.
 * Core ring: no I/O, no clock, no randomness, no model call.
 *
 * The plan (`docs/duygu-ve-dogal-sohbet-plan.md` section C, invariant 9) asks
 * for a workspace-bound conversation/session/message identity with ordering and
 * idempotency, a reply-to link, an allowed memory/admission path for the
 * relevant history, an explicit context budget, and a firm boundary that
 * message content is *untrusted data* -- never an instruction and never an
 * authority. This module owns exactly that contract and nothing else: it
 * selects context, it never stores it, and it never runs a turn.
 *
 * Two rules are load-bearing:
 *   - Nothing from another workspace or another session can be selected, and a
 *     turn whose identity does not match the workspace it was submitted under
 *     is refused outright. Context cannot leak across tenants.
 *   - A user's reported feeling (e.g. anger) is *reported*, not measured, and
 *     carries no reward authority. The plan forbids turning anger into an
 *     automatic negative reward, so this module never emits a reward at all;
 *     it only records the report so a later, separately gated slice can decide.
 *
 * Result carries signal-only authority: it cannot approve, block or execute.
 */

const { createHash } = require('node:crypto');
const { COGNITION_STATUS, AUTHORITY, freezeResult } = require('./contract');
const { isPlainObject } = require('../is-plain-object');
const { stableStringify } = require('../hash-chain');

const SCHEMA_VERSION = 'huqan-cognition-conversation-turn-v1';
const MAX_CONTEXT_ITEMS = 50;
const MAX_CONTEXT_CHARS = 8000;
const MAX_MESSAGE_CHARS = 100000;
const REPORTED_FEELINGS = Object.freeze([
  'anger', 'frustration', 'satisfaction', 'praise', 'neutral', 'unknown',
]);

const TURN_KEYS = Object.freeze([
  'conversationId', 'sessionId', 'messageId', 'sequence', 'content',
  'replyToMessageId', 'reportedFeeling', 'decisionRef', 'repairRef',
]);
const HISTORY_KEYS = Object.freeze([
  'conversationId', 'sessionId', 'workspaceId', 'messageId', 'sequence',
  'content', 'contentChars', 'sourceLabel', 'admissionId',
]);

const text = (value) => typeof value === 'string' && value.trim() !== '';
const hasOnlyKeys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const reject = (reason) => freezeResult({
  schemaVersion: SCHEMA_VERSION, workspaceId: null, conversationId: null, sessionId: null,
  messageId: null, sequence: null, status: COGNITION_STATUS.REJECT, reason,
  replyTo: null, context: [], dropped: [], crossWorkspace: [], content: null,
  reportedFeeling: null, references: {}, contextDigest: null,
  authority: AUTHORITY.SIGNAL_ONLY,
});

// The message body is opaque data. It is never parsed for instructions and
// never trusted with authority; only its length and a digest are surfaced.
function readContent(content) {
  if (!text(content)) return { status: 'INVALID' };
  if (content.length > MAX_MESSAGE_CHARS) return { status: 'TOO_LONG' };
  return { status: 'KNOWN', chars: content.length, digest: sha256(content) };
}

function readReportedFeeling(value) {
  if (value === undefined) return null;
  if (!isPlainObject(value) || !hasOnlyKeys(value, ['label', 'source'])) return { invalid: true };
  if (!text(value.source)) return { invalid: true };
  const label = REPORTED_FEELINGS.includes(value.label) ? value.label : 'unknown';
  // A report is an observation about the user, not a measurement of HUQAN's own
  // state, and it is explicitly barred from becoming a reward.
  return { label, source: value.source.trim(), asReported: true, rewardAuthority: 'NONE' };
}

function readTurn(turn, workspaceId) {
  if (!isPlainObject(turn) || !hasOnlyKeys(turn, TURN_KEYS)) return reject('invalid_turn');
  if (!text(turn.conversationId) || !text(turn.sessionId) || !text(turn.messageId)) return reject('invalid_identity');
  if (!Number.isSafeInteger(turn.sequence) || turn.sequence < 0) return reject('invalid_sequence');
  const content = readContent(turn.content);
  if (content.status !== 'KNOWN') return reject(content.status === 'TOO_LONG' ? 'content_too_long' : 'invalid_content');
  const feeling = readReportedFeeling(turn.reportedFeeling);
  if (feeling && feeling.invalid) return reject('invalid_reported_feeling');
  // A link field is either absent (null) or a non-empty string. A value of the
  // wrong type is a malformed link, not a missing one, so it is rejected the
  // same way as the other wrong-type fields instead of being silently dropped.
  const links = [turn.replyToMessageId, turn.decisionRef, turn.repairRef];
  for (const link of links) {
    if (link !== undefined && !text(link)) return reject('invalid_link');
  }
  const base = {
    workspaceId, conversationId: turn.conversationId.trim(), sessionId: turn.sessionId.trim(),
    messageId: turn.messageId.trim(), sequence: turn.sequence, content,
    replyToMessageId: turn.replyToMessageId === undefined ? null : turn.replyToMessageId.trim(),
    reportedFeeling: feeling ? freezeResult(feeling) : null,
    references: {
      decisionRef: turn.decisionRef === undefined ? null : turn.decisionRef.trim(),
      repairRef: turn.repairRef === undefined ? null : turn.repairRef.trim(),
    },
  };
  return base;
}

// A history item is only usable when it belongs to the same workspace and the
// same conversation, and it arrived through the allowed admission path (it
// carries an admissionId). Anything else is never selected and is reported.
function classifyHistory(item, turn) {
  if (!isPlainObject(item) || !hasOnlyKeys(item, HISTORY_KEYS)) return { kind: 'dropped', reason: 'invalid_history_item' };
  if (!text(item.workspaceId) || item.workspaceId !== turn.workspaceId) return { kind: 'crossWorkspace', reason: 'cross_workspace' };
  if (item.conversationId !== turn.conversationId) return { kind: 'dropped', reason: 'other_conversation' };
  if (!text(item.messageId) || !Number.isSafeInteger(item.sequence) || item.sequence < 0) {
    return { kind: 'dropped', reason: 'invalid_history_item' };
  }
  if (item.content !== undefined && item.content !== null && typeof item.content !== 'string') {
    return { kind: 'dropped', reason: 'invalid_history_item' };
  }
  // A durable store row carries no body (invariant 9), only its declared char
  // count; a declared count must be a real non-negative integer, not a value
  // that would silently under- or over-count the budget.
  if (item.contentChars !== undefined && item.contentChars !== null
    && (!Number.isSafeInteger(item.contentChars) || item.contentChars < 0)) {
    return { kind: 'dropped', reason: 'invalid_history_item' };
  }
  if (!text(item.admissionId)) return { kind: 'dropped', reason: 'not_admitted' };
  if (!text(item.sourceLabel)) return { kind: 'dropped', reason: 'missing_source_label' };
  // Replay is conversation-scoped: an admitted item carrying the turn's own
  // messageId is a replay even when it arrived under a different session.
  if (item.messageId.trim() === turn.messageId) return { kind: 'dropped', reason: 'duplicate_message' };
  if (item.sessionId !== turn.sessionId) return { kind: 'dropped', reason: 'other_session' };
  return { kind: 'candidate' };
}

function resolveReplyTo(turn, candidates) {
  if (!turn.replyToMessageId) return null;
  const target = candidates.find((item) => item.messageId === turn.replyToMessageId);
  if (!target) return freezeResult({ messageId: turn.replyToMessageId, resolved: false, reason: 'reply_target_not_admitted' });
  if (target.sequence >= turn.sequence) {
    return freezeResult({ messageId: turn.replyToMessageId, resolved: false, reason: 'reply_target_not_earlier' });
  }
  return freezeResult({ messageId: turn.replyToMessageId, resolved: true, sequence: target.sequence });
}

function selectContext(candidates, budget) {
  // Deterministic order: most recent first, ties broken by messageId, so the
  // same history and budget always yield the same context.
  const ordered = [...candidates].sort((a, b) => (b.sequence - a.sequence) || compareText(a.messageId, b.messageId));
  const selected = [];
  let chars = 0;
  for (const item of ordered) {
    if (selected.length >= budget.maxItems) break;
    if (chars + item.chars > budget.maxChars) continue;
    chars += item.chars;
    selected.push(freezeResult({
      messageId: item.messageId, sequence: item.sequence, sourceLabel: item.sourceLabel,
      admissionId: item.admissionId, chars: item.chars,
    }));
  }
  return { selected: freezeResult(selected), chars };
}

function readBudget(budget) {
  if (budget !== undefined && !isPlainObject(budget)) return null;
  const raw = budget === undefined ? {} : budget;
  const maxItems = raw.maxItems === undefined ? MAX_CONTEXT_ITEMS : raw.maxItems;
  const maxChars = raw.maxChars === undefined ? MAX_CONTEXT_CHARS : raw.maxChars;
  if (!Number.isInteger(maxItems) || maxItems < 0 || maxItems > MAX_CONTEXT_ITEMS) return null;
  if (!Number.isInteger(maxChars) || maxChars < 0 || maxChars > MAX_CONTEXT_CHARS) return null;
  return { maxItems, maxChars };
}

/**
 * Plan one conversation turn: validate identity, resolve reply-to, and select
 * the budgeted, same-workspace context. Nothing is stored and nothing runs.
 *
 * @param {{workspaceId: string, turn: object, history?: object[], budget?: object}} input
 * @returns {Readonly<object>} MEASURED plan, or REJECT for an unusable turn
 */
function planConversationTurn(input) {
  const { workspaceId, turn, history, budget } = input === undefined || input === null ? {} : input;
  if (!text(workspaceId)) return reject('invalid_workspace');
  const plan = readTurn(turn, workspaceId.trim());
  if (plan.status === COGNITION_STATUS.REJECT) return plan;
  const limits = readBudget(budget);
  if (!limits) return reject('invalid_budget');
  if (history !== undefined && !Array.isArray(history)) return reject('invalid_history');
  const items = Array.isArray(history) ? history : [];

  const candidates = [];
  const dropped = [];
  const crossWorkspace = [];
  let duplicate = false;
  for (const item of items) {
    const verdict = classifyHistory(item, plan);
    if (verdict.kind === 'crossWorkspace') { crossWorkspace.push(item && item.workspaceId); continue; }
    if (verdict.kind === 'dropped') {
      if (verdict.reason === 'duplicate_message') duplicate = true;
      dropped.push(verdict.reason);
      continue;
    }
    const chars = typeof item.content === 'string'
      ? item.content.length
      : (Number.isSafeInteger(item.contentChars) ? item.contentChars : 0);
    candidates.push({ ...item, messageId: item.messageId.trim(), chars });
  }
  // Idempotency: a messageId already admitted in this conversation is a replay.
  if (duplicate) return reject('duplicate_message');
  // A message can occupy at most one context slot: a repeated admitted id would
  // otherwise fill two slots, and resolveReplyTo would pick one by input order.
  const byId = new Map();
  for (const candidate of candidates) if (!byId.has(candidate.messageId)) byId.set(candidate.messageId, candidate);
  const unique = [...byId.values()];

  const replyTo = resolveReplyTo(plan, unique);
  const { selected, chars } = selectContext(unique, limits);
  const contextDigest = sha256(stableStringify(selected.map((item) => [item.messageId, item.admissionId, item.sourceLabel])));

  return freezeResult({
    schemaVersion: SCHEMA_VERSION,
    workspaceId: plan.workspaceId, conversationId: plan.conversationId, sessionId: plan.sessionId,
    messageId: plan.messageId, sequence: plan.sequence, status: COGNITION_STATUS.MEASURED,
    replyTo,
    context: selected,
    contextChars: chars,
    budget: limits,
    dropped: dropped.sort(compareText),
    crossWorkspace,
    // The body is data with no authority; only its size and digest are surfaced.
    content: freezeResult({ chars: plan.content.chars, digest: plan.content.digest, authority: 'DATA_ONLY', instruction: false }),
    reportedFeeling: plan.reportedFeeling,
    references: freezeResult(plan.references),
    contextDigest,
    authority: AUTHORITY.SIGNAL_ONLY,
  });
}

module.exports = Object.freeze({
  SCHEMA_VERSION, MAX_CONTEXT_ITEMS, MAX_CONTEXT_CHARS, MAX_MESSAGE_CHARS, REPORTED_FEELINGS,
  planConversationTurn,
});

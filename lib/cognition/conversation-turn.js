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
  'content', 'sourceLabel', 'admissionId',
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
  if (!Number.isInteger(turn.sequence) || turn.sequence < 0) return reject('invalid_sequence');
  const content = readContent(turn.content);
  if (content.status !== 'KNOWN') return reject(content.status === 'TOO_LONG' ? 'content_too_long' : 'invalid_content');
  const feeling = readReportedFeeling(turn.reportedFeeling);
  if (feeling && feeling.invalid) return reject('invalid_reported_feeling');
  const base = {
    workspaceId, conversationId: turn.conversationId.trim(), sessionId: turn.sessionId.trim(),
    messageId: turn.messageId.trim(), sequence: turn.sequence, content,
    replyToMessageId: text(turn.replyToMessageId) ? turn.replyToMessageId.trim() : null,
    reportedFeeling: feeling ? freezeResult(feeling) : null,
    references: {
      decisionRef: text(turn.decisionRef) ? turn.decisionRef.trim() : null,
      repairRef: text(turn.repairRef) ? turn.repairRef.trim() : null,
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
  if (item.sessionId !== turn.sessionId) return { kind: 'dropped', reason: 'other_session' };
  if (!text(item.messageId) || !Number.isInteger(item.sequence) || item.sequence < 0) {
    return { kind: 'dropped', reason: 'invalid_history_item' };
  }
  if (!text(item.admissionId)) return { kind: 'dropped', reason: 'not_admitted' };
  if (!text(item.sourceLabel)) return { kind: 'dropped', reason: 'missing_source_label' };
  if (item.messageId === turn.messageId) return { kind: 'dropped', reason: 'duplicate_message' };
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
  const raw = isPlainObject(budget) ? budget : {};
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
function planConversationTurn({ workspaceId, turn, history, budget } = {}) {
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
    candidates.push({ ...item, chars: item.content ? String(item.content).length : 0 });
  }
  // Idempotency: a messageId already admitted in this conversation is a replay.
  if (duplicate) return reject('duplicate_message');

  const replyTo = resolveReplyTo(plan, candidates);
  const { selected, chars } = selectContext(candidates, limits);
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

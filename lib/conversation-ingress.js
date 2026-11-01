'use strict';

/**
 * COG-C (#4393, PR-3): the shared conversation ingress adapter.
 *
 * PR-1 shipped the pure `lib/cognition/conversation-turn.js` contract and PR-2
 * the workspace-bound store and its own HTTP surface. This module is the thin
 * adapter the plan asks for between the *existing* ingress surfaces
 * (`lib/http/answer-route.js`, `lib/llm-proxy/proxy-handler.js`) and that
 * service: those surfaces keep their current response byte-for-byte and, as an
 * opt-in side effect, record the turn they just served.
 *
 * It is Core ring because both an inbound surface (UI) and the LLM proxy
 * (Adapters) must reach it, and Core is the only ring they may both require.
 * Core may not import the admission gate (Adapters), so the gate is *injected*
 * by the caller -- the same dependency-injection shape `createAnswerRoute(deps)`
 * and `createCoreHttpRoutes(deps)` already use -- and this module stays free of
 * any upward import.
 *
 * Two invariants are inherited from the plan and not restated away here:
 *   - an unadmitted turn is never recorded, so it can never become context;
 *   - message content is untrusted data, so only its digest and length reach
 *     the journal. The body is never stored, returned or echoed.
 *
 * Recording is best-effort by contract: `recordIngressTurn` never throws, so a
 * journal outage or a conflicting retry degrades to a logged reason instead of
 * changing an answer the caller already served.
 */

const { appendConversationTurn } = require('./conversation-store');
const { sha256Hex } = require('./hash-chain');

const MAX_CONTENT_CHARS = 100000;
const DEFAULT_SOURCE_LABEL = 'user';
const ADMISSION_AGENT_ID = 'conversation';
const ADMISSION_POLICY_VERSION = 'conversation-v1';

const isText = (value) => typeof value === 'string' && value.trim() !== '';
const isSequence = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * The admission request one conversation turn is decided by. Exported so the
 * authoritative surface (`lib/http/conversation-route.js`) and this adapter ask
 * the same question of the gate rather than each spelling it out.
 */
function buildConversationAdmissionRequest({ workspaceId, messageId }) {
  return {
    workspaceId,
    actor: 'user',
    agentId: ADMISSION_AGENT_ID,
    memoryDraftId: messageId,
    trustPolicyVersion: ADMISSION_POLICY_VERSION,
    reason: 'conversation turn',
    provenanceId: messageId,
    riskScore: 0,
    proposedMemory: {},
  };
}

const refuse = (reason, extra = {}) => ({ recorded: false, replayed: false, reason, admissionId: null, ...extra });

/**
 * Record one turn an ingress surface has just served.
 *
 * Opt-in: a caller that was not given a complete conversation identity
 * (workspace, conversation, message and an explicit sequence) records nothing
 * and its response is unchanged. `sequence` is required rather than derived,
 * because a derived value would differ between a first attempt and a retry and
 * turn an idempotent replay into a conflict.
 *
 * @param {{graph: object, evaluateAdmission: Function, workspaceId: string,
 *   conversationId: string, sessionId?: string, messageId: string,
 *   sequence: number, content: string, sourceLabel?: string,
 *   replyToMessageId?: string, retention?: string, at?: string}} input
 * @returns {{recorded: boolean, replayed: boolean, reason: string|null,
 *   admissionId: string|null, decision?: string}}
 */
function recordIngressTurn(input = {}) {
  // A null argument would throw in the destructuring below, before any refusal
  // path; the contract is that this function never throws.
  const {
    graph, evaluateAdmission, workspaceId, conversationId, sessionId, messageId,
    sequence, content, sourceLabel, replyToMessageId, retention, at,
  } = input || {};

  if (!isText(workspaceId) || !isText(conversationId) || !isText(messageId)
    || !isText(sessionId) || !isSequence(sequence)) {
    return refuse('identity_incomplete');
  }
  if (typeof content !== 'string' || content.trim() === '') return refuse('empty_content');
  if (content.length > MAX_CONTENT_CHARS) return refuse('content_too_long');
  if (typeof evaluateAdmission !== 'function') return refuse('no_admission_port');

  let decision;
  try {
    decision = evaluateAdmission(buildConversationAdmissionRequest({ workspaceId, messageId }));
  } catch (error) {
    // Same reason as the store failure below: the caller has already served its
    // response and discards the return value, so the log is the only trace.
    console.error('[conversation-ingress] turn not recorded (admission_failed):', error && error.message);
    return refuse('admission_failed');
  }
  if (!decision || decision.ok !== true || !decision.decision || decision.decision.decision !== 'allow') {
    return refuse('not_admitted', {
      decision: decision && decision.decision ? decision.decision.decision : 'reject',
    });
  }

  const admissionId = decision.decision.admissionId;
  try {
    const result = appendConversationTurn(graph, {
      workspaceId,
      conversationId,
      sessionId,
      messageId,
      sequence,
      contentDigest: sha256Hex(content),
      contentChars: content.length,
      sourceLabel: sourceLabel || DEFAULT_SOURCE_LABEL,
      admissionId,
      replyToMessageId,
      retention,
      at,
    });
    return { recorded: result.stored, replayed: result.replayed, reason: result.reason || null, admissionId };
  } catch (error) {
    // A TypeError is the store's refusal (a conflicting retry, or a re-record
    // of a deleted message); anything else is a journal outage. Both are a
    // reason here, never a thrown error, because the caller has already served
    // its response and must not be told to retract it. The operator still gets
    // the signal: the caller discards the return value, so the log is the only
    // trace an unrecorded turn leaves.
    const reason = error instanceof TypeError ? 'conflict' : 'store_unavailable';
    console.error(`[conversation-ingress] turn not recorded (${reason}):`, error && error.message);
    return refuse(reason, { admissionId });
  }
}

/**
 * Bind the adapter to one graph and one gate, so a wiring site passes a single
 * function to a surface instead of repeating the closure. The gate stays
 * injected: this module never imports the Adapters ring.
 *
 * @param {{graph: object, evaluateAdmission: Function}} deps
 * @returns {(turn: object) => object}
 */
function createIngressRecorder({ graph, evaluateAdmission }) {
  return (turn) => recordIngressTurn({ graph, evaluateAdmission, ...turn });
}

module.exports = Object.freeze({
  recordIngressTurn,
  createIngressRecorder,
  buildConversationAdmissionRequest,
});

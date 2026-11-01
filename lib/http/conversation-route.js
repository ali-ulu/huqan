'use strict';

/**
 * COG-C (#4393, PR-2): the conversation surface.
 *
 *   POST   /api/conversation/turns  submit one turn
 *   GET    /api/conversation/turns  read the stored history (metadata only)
 *   DELETE /api/conversation/turns  tombstone one stored message
 *
 * This is the thin adapter the plan asked for: the durable store
 * (`lib/conversation-store.js`) owns persistence over the single journal, the
 * pure `lib/cognition/conversation-turn.js` contract owns selection, and this
 * module only moves a request between them. It never plans a turn itself and
 * never stores a body: the message text is untrusted data, so only its digest
 * and length are written, and the body is never echoed back.
 *
 * Admission is the trust boundary. A turn is persisted only when the shared
 * admission gate answers `allow`; any other decision is reported and the turn
 * is not written, so an unadmitted turn can never become context for a later
 * one. The workspace on the request is the only workspace read or written:
 * history is scoped to it in the store and the planner refuses anything else.
 *
 * Returns true when the path belongs to this surface (even on 4xx), false
 * otherwise, so the dispatcher can fall through.
 */

const { normalizeWorkspaceId } = require('../workspace-id');
const { evaluateMemoryAdmission } = require('../memory-admission-gate');
const { buildConversationAdmissionRequest } = require('../conversation-ingress');
const { emergencyStopRefusal } = require('./emergency-stop-gate');
const { isPlainObject } = require('../is-plain-object');
const { sha256Hex } = require('../hash-chain');
const {
  appendConversationTurn,
  readConversationHistory,
  deleteConversationMessage,
  planConversationTurnFromStore,
  RETENTION_MODES,
} = require('../conversation-store');

const CONVERSATION_PATH = '/api/conversation/turns';
const HEADERS = Object.freeze({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
const MAX_CONTENT_CHARS = 100000;
const MAX_BODY_BYTES = 262144;
const MAX_ID_CHARS = 256;
const MAX_HISTORY_LIMIT = 200;

const text = (value) => (typeof value === 'string' ? value.trim() : '');

// A query value is used verbatim. It is never stripped or truncated into a
// different, valid-looking id: `m%0A_1` must not become `m_1` and delete a
// different message. An invalid value is refused by the store's identifier
// check, which throws and is mapped to 400 below.
const queryValue = (reqUrl, key) => {
  const params = (reqUrl && reqUrl.searchParams) || null;
  if (!params || typeof params.get !== 'function') return undefined;
  const value = params.get(key);
  return value === null ? undefined : value;
};

// The store throws a TypeError on a bad identifier (empty, oversized, or a
// control character). That must be a 400 from every handler, so the check is
// made here too rather than only inside the POST body path.
// oxlint-disable-next-line no-control-regex -- deliberate: an identifier may not carry control characters
const CONTROL_CHARS = /[\x00-\x1F\x7F]/;
const badIdentifier = (value) => typeof value !== 'string'
  || value.trim() === '' || value.length > MAX_ID_CHARS || CONTROL_CHARS.test(value);

/** Resolve the workspace from the body or the query, and refuse a bad one. */
function resolveWorkspace(body, reqUrl) {
  const raw = (isPlainObject(body) && body.workspaceId !== undefined)
    ? body.workspaceId
    : queryValue(reqUrl, 'workspaceId');
  try {
    return { ok: true, workspaceId: normalizeWorkspaceId(raw, { required: true }) };
  } catch {
    return { ok: false, code: 'INVALID_WORKSPACE_ID' };
  }
}

function readTurnInput(body, workspaceId) {
  if (!isPlainObject(body)) return { ok: false, code: 'INVALID_INPUT', message: 'body must be an object' };
  const content = body.content;
  if (typeof content !== 'string' || content.trim() === '') {
    return { ok: false, code: 'INVALID_INPUT', message: 'content is required' };
  }
  if (content.length > MAX_CONTENT_CHARS) {
    return { ok: false, code: 'CONTENT_TOO_LONG', message: 'content is too long' };
  }
  // Every identifier is validated here, before the planner runs, so a bad one
  // is a 400 rather than the 500 the planner's throw would become.
  for (const field of ['conversationId', 'messageId', 'sessionId']) {
    if (badIdentifier(body[field])) {
      return { ok: false, code: 'INVALID_INPUT', message: `${field} is invalid` };
    }
  }
  const retention = body.retention === undefined ? 'conversation' : body.retention;
  if (!RETENTION_MODES.includes(retention)) {
    return { ok: false, code: 'INVALID_RETENTION', message: `retention must be one of ${RETENTION_MODES.join(', ')}` };
  }
  return {
    ok: true,
    workspaceId,
    retention,
    turn: {
      conversationId: text(body.conversationId),
      sessionId: text(body.sessionId),
      messageId: text(body.messageId),
      sequence: body.sequence,
      content,
      ...(body.replyToMessageId !== undefined ? { replyToMessageId: text(body.replyToMessageId) } : {}),
      ...(body.reportedFeeling !== undefined ? { reportedFeeling: body.reportedFeeling } : {}),
      ...(body.decisionRef !== undefined ? { decisionRef: text(body.decisionRef) } : {}),
      ...(body.repairRef !== undefined ? { repairRef: text(body.repairRef) } : {}),
    },
  };
}

/**
 * Only a turn the admission gate allows may be written. The decision is
 * returned verbatim so a caller can see `review`/`quarantine`/`reject` instead
 * of a silent success.
 */
function admitTurn({ workspaceId, turn }) {
  const decision = evaluateMemoryAdmission(buildConversationAdmissionRequest({ workspaceId, messageId: turn.messageId }));
  if (!decision.ok || !decision.decision) {
    return { admitted: false, decision: 'reject', reason: 'admission_invalid' };
  }
  return {
    admitted: decision.decision.decision === 'allow',
    decision: decision.decision.decision,
    admissionId: decision.decision.admissionId,
    reason: decision.decision.reason || null,
  };
}

/** Project a stored row into the response shape (no body, no extra keys). */
function toHistoryItem(row) {
  return {
    conversationId: row.conversationId,
    sessionId: row.sessionId,
    messageId: row.messageId,
    sequence: row.sequence,
    contentChars: row.contentChars,
    sourceLabel: row.sourceLabel,
    admissionId: row.admissionId,
    replyToMessageId: row.replyToMessageId,
    reportedFeeling: row.reportedFeeling || null,
  };
}

function handleRead(req, res, reqUrl, graph, workspace, writeJson, writeApiError) {
  if (!workspace.ok) {
    writeApiError(req, res, 400, workspace.code, 'workspaceId is required');
    return true;
  }
  const conversationId = queryValue(reqUrl, 'conversationId');
  if (badIdentifier(conversationId)) {
    writeApiError(req, res, 400, 'INVALID_INPUT', 'conversationId is required');
    return true;
  }
  const limit = readLimit(reqUrl);
  if (limit === null) {
    writeApiError(req, res, 400, 'INVALID_INPUT', 'limit must be a non-negative integer');
    return true;
  }
  let history;
  try {
    history = readConversationHistory(graph, { workspaceId: workspace.workspaceId, conversationId, limit });
  } catch (error) {
    // A failed read must not report an empty history as success: the deletion
    // boundary cannot be trusted, so nothing is served. An unusable scope is
    // the caller's bad input, not an outage.
    if (error && error.code === 'INVALID_CONVERSATION_SCOPE') {
      writeApiError(req, res, 400, 'INVALID_INPUT', error.message);
      return true;
    }
    writeApiError(req, res, 503, 'CONVERSATION_READ_FAILED', 'conversation history is unavailable');
    return true;
  }
  writeJson(req, res, 200, {
    ok: true,
    workspaceId: workspace.workspaceId,
    conversationId,
    count: history.length,
    turns: history.map(toHistoryItem),
    authority: 'SIGNAL_ONLY',
  }, HEADERS);
  return true;
}

function handleDelete(req, res, reqUrl, graph, workspace, writeJson, writeApiError) {
  if (!workspace.ok) {
    writeApiError(req, res, 400, workspace.code, 'workspaceId is required');
    return true;
  }
  const conversationId = queryValue(reqUrl, 'conversationId');
  const messageId = queryValue(reqUrl, 'messageId');
  if (badIdentifier(conversationId) || badIdentifier(messageId)) {
    writeApiError(req, res, 400, 'INVALID_INPUT', 'conversationId and messageId are required');
    return true;
  }
  try {
    const result = deleteConversationMessage(graph, { workspaceId: workspace.workspaceId, conversationId, messageId });
    writeJson(req, res, 200, { ok: true, ...result, authority: 'SIGNAL_ONLY' }, HEADERS);
  } catch (error) {
    // A rejected id (TypeError) or an unusable scope is bad input; a failed
    // journal read is an outage and must not be reported as a 400.
    if (error instanceof TypeError) {
      writeApiError(req, res, 400, 'INVALID_INPUT', error.message);
      return true;
    }
    writeApiError(req, res, 503, 'CONVERSATION_READ_FAILED', 'conversation history is unavailable');
  }
  return true;
}

/** The optional `limit` query value, or null when it is not a valid bound. */
function readLimit(reqUrl) {
  const raw = queryValue(reqUrl, 'limit');
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > MAX_HISTORY_LIMIT) return null;
  return value;
}

function handleSubmit(req, res, reqUrl, graph, writeJson, writeApiError, parseJsonRequest, emergencyStop) {
  return (async () => {
    const body = await parseJsonRequest(req, res, { maxBytes: MAX_BODY_BYTES });
    if (body === null || body === undefined) return true;
    const workspace = resolveWorkspace(body, reqUrl);
    const stop = emergencyStopRefusal({ emergencyStop, workspaceId: workspace.ok ? workspace.workspaceId : undefined });
    if (stop) {
      writeApiError(req, res, stop.statusCode, stop.code, stop.message);
      return true;
    }
    if (!workspace.ok) {
      writeApiError(req, res, 400, workspace.code, 'workspaceId is required');
      return true;
    }
    const input = readTurnInput(body, workspace.workspaceId);
    if (!input.ok) {
      writeApiError(req, res, 400, input.code, input.message);
      return true;
    }
    // The store plans against this conversation's prior turns only: the turn
    // being submitted is not its own context. This is where the pure contract
    // runs in production -- it validates the identity, resolves the reply-to
    // link, and selects the budgeted, same-workspace, admitted context whose
    // source tags are returned. Platform consumes one published Memory port.
    let plan;
    try {
      plan = planConversationTurnFromStore(graph, {
        workspaceId: workspace.workspaceId,
        conversationId: input.turn.conversationId,
        messageId: input.turn.messageId,
        turn: input.turn,
      });
    } catch (error) {
      // A scope that cannot be read back is the caller's bad input (400); any
      // other read failure means the plan cannot be built against partial
      // history, so the submit fails closed (503).
      if (error && error.code === 'INVALID_CONVERSATION_SCOPE') {
        writeApiError(req, res, 400, 'INVALID_INPUT', error.message);
        return true;
      }
      writeApiError(req, res, 503, 'CONVERSATION_READ_FAILED', 'conversation history is unavailable');
      return true;
    }
    if (plan.status === 'REJECT') {
      writeApiError(req, res, 400, 'INVALID_TURN', `turn refused: ${plan.reason}`);
      return true;
    }
    const admission = admitTurn(input);
    if (!admission.admitted) {
      writeJson(req, res, 200, {
        ok: false,
        stored: false,
        decision: admission.decision,
        reason: admission.reason,
        authority: 'SIGNAL_ONLY',
      }, HEADERS);
      return true;
    }
    try {
      const result = appendConversationTurn(graph, {
        workspaceId: workspace.workspaceId,
        conversationId: input.turn.conversationId,
        sessionId: input.turn.sessionId,
        messageId: input.turn.messageId,
        sequence: input.turn.sequence,
        contentDigest: sha256Hex(input.turn.content),
        contentChars: input.turn.content.length,
        sourceLabel: 'user',
        admissionId: admission.admissionId,
        replyToMessageId: input.turn.replyToMessageId,
        decisionRef: input.turn.decisionRef,
        repairRef: input.turn.repairRef,
        // Only the planner's normalized label is persisted. The planner keeps
        // `source` as free text, so storing the raw report would let a client
        // put message text into the journal -- content the design withholds.
        ...(plan.reportedFeeling ? { reportedFeeling: { label: plan.reportedFeeling.label } } : {}),
        retention: input.retention,
      });
      writeJson(req, res, 200, {
        ok: true,
        stored: result.stored,
        replayed: result.replayed,
        retention: input.retention,
        reason: result.reason || null,
        decision: admission.decision,
        // The plan is signal-only: it reports what context was selected and
        // under which budget, and carries no authority to act on it.
        context: {
          items: plan.context.map((item) => ({
            messageId: item.messageId,
            sequence: item.sequence,
            sourceLabel: item.sourceLabel,
            chars: item.chars,
          })),
          chars: plan.contextChars,
          budget: plan.budget,
          digest: plan.contextDigest,
          dropped: plan.dropped,
          crossWorkspace: plan.crossWorkspace,
        },
        replyTo: plan.replyTo,
        authority: 'SIGNAL_ONLY',
      }, HEADERS);
    } catch (error) {
      // A rejected payload (TypeError: a conflicting retry, a re-record of a
      // deleted message) is a conflict; a failed journal read is an outage.
      if (error instanceof TypeError) {
        writeApiError(req, res, 409, 'CONVERSATION_CONFLICT', error.message);
        return true;
      }
      writeApiError(req, res, 503, 'CONVERSATION_READ_FAILED', 'conversation history is unavailable');
    }
    return true;
  })();
}

function handleConversationRequest({ req, res, reqUrl, kernel, parseJsonRequest, writeJson, writeApiError, emergencyStop }) {
  const pathname = reqUrl && reqUrl.pathname;
  if (typeof pathname !== 'string' || pathname !== CONVERSATION_PATH) return false;
  const method = String(req.method || 'GET').toUpperCase();
  const graph = kernel && kernel.graph;
  if (!graph) {
    writeApiError(req, res, 503, 'GRAPH_UNAVAILABLE', 'Graph is not available.');
    return true;
  }
  if (method === 'POST') return handleSubmit(req, res, reqUrl, graph, writeJson, writeApiError, parseJsonRequest, emergencyStop);
  // A GET/DELETE names its workspace in the query, so the stop is reported
  // before any read. A POST carries it in the body, so its stop check runs
  // inside handleSubmit once the body has been parsed.
  const workspace = resolveWorkspace(null, reqUrl);
  const stop = emergencyStopRefusal({ emergencyStop, workspaceId: workspace.ok ? workspace.workspaceId : undefined });
  if (stop) {
    writeApiError(req, res, stop.statusCode, stop.code, stop.message);
    return true;
  }
  if (method === 'GET') return handleRead(req, res, reqUrl, graph, workspace, writeJson, writeApiError);
  if (method === 'DELETE') return handleDelete(req, res, reqUrl, graph, workspace, writeJson, writeApiError);
  writeApiError(req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  return true;
}

module.exports = Object.freeze({ CONVERSATION_PATH, handleConversationRequest });

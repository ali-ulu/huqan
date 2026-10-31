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

const text = (value) => (typeof value === 'string' ? value.trim() : '');

function sanitize(value, maxLen) {
  if (typeof value !== 'string') return undefined;
  // oxlint-disable-next-line no-control-regex -- deliberate: strips control characters from query input
  return value.slice(0, maxLen).replace(/[\x00-\x1F\x7F]/g, '').trim();
}

function queryValue(reqUrl, key) {
  const params = (reqUrl && reqUrl.searchParams) || null;
  if (!params || typeof params.get !== 'function') return undefined;
  const value = params.get(key);
  return value === null ? undefined : value;
}

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
  const decision = evaluateMemoryAdmission({
    workspaceId,
    actor: 'user',
    agentId: 'conversation',
    memoryDraftId: turn.messageId,
    trustPolicyVersion: 'conversation-v1',
    reason: 'conversation turn',
    provenanceId: turn.messageId,
    riskScore: 0,
    proposedMemory: {},
  });
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
  const conversationId = sanitize(queryValue(reqUrl, 'conversationId'), 257);
  if (!conversationId) {
    writeApiError(req, res, 400, 'INVALID_INPUT', 'conversationId is required');
    return true;
  }
  const history = readConversationHistory(graph, { workspaceId: workspace.workspaceId, conversationId });
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
  const conversationId = sanitize(queryValue(reqUrl, 'conversationId'), 257);
  const messageId = sanitize(queryValue(reqUrl, 'messageId'), 257);
  if (!conversationId || !messageId) {
    writeApiError(req, res, 400, 'INVALID_INPUT', 'conversationId and messageId are required');
    return true;
  }
  try {
    const result = deleteConversationMessage(graph, { workspaceId: workspace.workspaceId, conversationId, messageId });
    writeJson(req, res, 200, { ok: true, ...result, authority: 'SIGNAL_ONLY' }, HEADERS);
  } catch (error) {
    writeApiError(req, res, 400, 'INVALID_INPUT', error.message);
  }
  return true;
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
    const plan = planConversationTurnFromStore(graph, {
      workspaceId: workspace.workspaceId,
      conversationId: input.turn.conversationId,
      messageId: input.turn.messageId,
      turn: input.turn,
    });
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
        ...(input.turn.reportedFeeling !== undefined ? { reportedFeeling: input.turn.reportedFeeling } : {}),
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
      writeApiError(req, res, 409, 'CONVERSATION_CONFLICT', error.message);
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

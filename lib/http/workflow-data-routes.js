'use strict';

const { workflowEnvelope } = require('./workflow-envelope');
const { formatApprovalRecord } = require('../mcp-approval-views');
const { readExactWorkspace } = require('./exact-workspace');
const { receiptReadFailure } = require('./receipt-read-failures');
const { validateWorkflowHttpRequest } = require('./workflow-request-validation');
const { bindHttpProvenance } = require('./http-provenance');

// Fixed public vocabulary for a failed receipt read (#1283, mirroring #737's
// fix in lib/workbench/trust-receipt-inspector.js). The receipt read path can
// surface validation, persistence, serialization and driver errors, and
// those raw messages can carry filesystem paths, driver state, schema
// internals or fragments of malformed stored content -- none of which
// belongs in an HTTP response to any authenticated caller. The underlying
// error is logged, never returned.
const RECEIPT_READ_MESSAGES = Object.freeze({
  receipt_not_found: 'receipt was not found',
  invalid_receipt_id: 'receiptId is not valid',
  receipt_chain_invalid: 'stored receipt chain is invalid',
});

function reportInternalReceiptReadFailure(receiptId, error) {
  console.error('[trust-receipt-detail] read failed for %s:', receiptId, error);
}
const { buildIngestWorkflowPreview } = require('../ingest-workflow-preview');
const { buildIngestWorkflowRun } = require('../ingest-workflow-run');
const { createAgentWorkflowRoutes } = require('./agent-workflow-routes');

const NO_STORE = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});
const DEFAULT_BODY_MAX_BYTES = 8_192;
const MUTATION_BODY_MAX_BYTES = 1_048_576;

function approvalWorkspace(approval) {
  return String(
    approval?.workspaceId
      || approval?.context?.snapshot?.workspaceId
      || approval?.context?.workspaceId
      || '',
  );
}

function failure(writeJson, req, res, statusCode, workflowId, code, message, details = {}) {
  writeJson(req, res, statusCode, {
    workflowId,
    ...workflowEnvelope({ ok: false, status: 'failed', error: { code, message, details } }),
  }, NO_STORE);
}

function createWorkflowDataRoutes({
  getApprovalStore,
  decideApproval,
  readReceipt,
  parseJsonRequest,
  writeJson,
  learnDocument,
  submitIngest,
  createAgent,
}) {
  if (![getApprovalStore, decideApproval, readReceipt, parseJsonRequest, writeJson, learnDocument, submitIngest, createAgent].every(fn => typeof fn === 'function')) {
    throw new TypeError('workflow data route dependencies are required');
  }

  // Agent plan/run keep their own module, but they enter through this router so
  // server.js gains no dispatch of its own (#328 keeps that file from growing).
  const handleAgentWorkflow = createAgentWorkflowRoutes({ createAgent, parseJsonRequest, writeJson });

  return async function handleWorkflowDataRoute(req, res, reqUrl) {
    if (await handleAgentWorkflow(req, res, reqUrl)) return true;
    const approvalMatch = reqUrl.pathname.match(/^\/api\/v2\/approvals(?:\/([^/]+)(?:\/decision)?)?$/);
    const receiptMatch = reqUrl.pathname.match(/^\/api\/v2\/trust-receipts\/([^/]+)$/);
    const ingestPreview = reqUrl.pathname === '/api/v2/ingest/preview';
    const ingestExecute = reqUrl.pathname === '/api/v2/ingest/execute';
    const learnReview = reqUrl.pathname === '/api/v2/workflows/learn';
    const ingestRunMatch = reqUrl.pathname.match(/^\/api\/v2\/ingest\/runs\/([^/]+)$/);
    if (!approvalMatch && !receiptMatch && !ingestPreview && !ingestExecute && !learnReview && !ingestRunMatch) return false;

    if (learnReview) {
      if (req.method !== 'POST') {
        failure(writeJson, req, res, 405, 'learn-review', 'METHOD_NOT_ALLOWED', 'Method not allowed');
        return true;
      }
      const body = await parseJsonRequest(req, res, { maxBytes: MUTATION_BODY_MAX_BYTES });
      if (!body) return true;
      const validationError = validateWorkflowHttpRequest('learn-review', body);
      if (validationError) {
        failure(writeJson, req, res, 400, 'learn-review', 'INVALID_INPUT', validationError);
        return true;
      }
      const workspaceId = String(body.workspaceId || '').trim();
      const inputText = String(body.text || '').trim();
      if (!workspaceId || !inputText) {
        failure(writeJson, req, res, 400, 'learn-review', 'INVALID_INPUT', 'workspaceId and text are required.');
        return true;
      }
      const result = learnDocument(inputText, {
        returnDetails: true,
        workspaceId,
        sourceType: String(body.sourceType || '').trim() || 'upload',
        sourceRef: String(body.sourceRef || '').trim() || '/api/v2/workflows/learn',
        sourceTitle: String(body.sourceTitle || '').trim() || 'HTTP workflow learn',
        actor: 'http-api',
        approvalRequired: true,
        provenance: bindHttpProvenance(body.provenance, {
          actor: 'http-api',
          workspaceId,
          sourceType: String(body.sourceType || '').trim() || 'upload',
          sourceRef: String(body.sourceRef || '').trim() || '/api/v2/workflows/learn',
          sourceTitle: String(body.sourceTitle || '').trim() || 'HTTP workflow learn',
        }),
      });
      const admission = Array.isArray(result.admissions) ? (result.admissions.find(Boolean) || null) : null;
      const outcome = String(admission?.outcome || admission?.decision || '').toLowerCase();
      const status = outcome === 'review' ? 'review_required' : (outcome === 'quarantine' ? 'blocked' : 'completed');
      writeJson(req, res, status === 'review_required' ? 202 : 200, {
        workflowId: 'learn-review',
        ...workflowEnvelope({ ok: status === 'completed', status, data: { learned: result.learned, admission, workspaceId }, receiptId: admission?.receipt?.receiptId || admission?.receiptId }),
      }, NO_STORE);
      return true;
    }

    if (ingestExecute) {
      if (req.method !== 'POST') {
        failure(writeJson, req, res, 405, 'ingest-execute', 'METHOD_NOT_ALLOWED', 'Method not allowed');
        return true;
      }
      const body = await parseJsonRequest(req, res, { maxBytes: MUTATION_BODY_MAX_BYTES });
      if (!body) return true;
      const validationError = validateWorkflowHttpRequest('ingest-execute', body);
      if (validationError) {
        failure(writeJson, req, res, 400, 'ingest-execute', 'INVALID_INPUT', validationError);
        return true;
      }
      const outcome = await submitIngest(body);
      if (outcome.error) {
        failure(writeJson, req, res, outcome.status, 'ingest-execute', outcome.error.code, outcome.error.message);
        return true;
      }
      const runId = String(outcome.json?.approval?.id || '');
      writeJson(req, res, outcome.status, {
        workflowId: 'ingest-execute',
        ...workflowEnvelope({
          ok: false,
          status: 'review_required',
          data: {
            ...outcome.json,
            runId,
            statusRoute: runId ? `/api/v2/ingest/runs/${encodeURIComponent(runId)}` : null,
          },
        }),
      }, NO_STORE);
      return true;
    }
    if (ingestPreview) {
      if (req.method !== 'POST') {
        failure(writeJson, req, res, 405, 'ingest-preview', 'METHOD_NOT_ALLOWED', 'Method not allowed');
        return true;
      }
      const body = await parseJsonRequest(req, res, { maxBytes: DEFAULT_BODY_MAX_BYTES });
      if (!body) return true;
      const validationError = validateWorkflowHttpRequest('ingest-preview', body);
      if (validationError) {
        failure(writeJson, req, res, 400, 'ingest-preview', 'INVALID_INPUT', validationError);
        return true;
      }
      const preview = buildIngestWorkflowPreview(body);
      if (!preview.ok) {
        failure(writeJson, req, res, preview.code === 'INGEST_WORKSPACE_UNSUPPORTED' ? 400 : 409,
          'ingest-preview', preview.code || 'INVALID_INGEST', preview.error || 'Ingest cannot be previewed safely.');
        return true;
      }
      writeJson(req, res, 200, {
        workflowId: 'ingest-preview',
        ...workflowEnvelope({ ok: true, status: 'completed', data: preview }),
      }, NO_STORE);
      return true;
    }

    if (ingestRunMatch) {
      if (req.method !== 'GET') {
        failure(writeJson, req, res, 405, 'ingest-run-detail', 'METHOD_NOT_ALLOWED', 'Method not allowed');
        return true;
      }
    } else if (receiptMatch) {
      if (req.method !== 'GET') {
        failure(writeJson, req, res, 405, 'trust-receipt-detail', 'METHOD_NOT_ALLOWED', 'Method not allowed');
        return true;
      }
    } else {
      const expectsPost = reqUrl.pathname.endsWith('/decision');
      if (req.method !== (expectsPost ? 'POST' : 'GET')) {
        const methodWorkflowId = expectsPost ? 'approval-decision' : (approvalMatch[1] ? 'approval-detail' : 'approvals');
        failure(writeJson, req, res, 405, methodWorkflowId, 'METHOD_NOT_ALLOWED', 'Method not allowed');
        return true;
      }
    }

    const workspace = readExactWorkspace(reqUrl.searchParams);
    if (!workspace.ok) {
      failure(writeJson, req, res, 400, ingestRunMatch ? 'ingest-run-detail' : approvalMatch ? 'approvals' : 'trust-receipt-detail', workspace.code,
        'Exactly one non-empty workspaceId is required.');
      return true;
    }

    if (ingestRunMatch) {
      let runId;
      try { runId = decodeURIComponent(ingestRunMatch[1]); } catch (_) { runId = ''; }
      let store;
      try { store = getApprovalStore(); } catch (_) {
        failure(writeJson, req, res, 503, 'ingest-run-detail', 'APPROVAL_STORE_UNAVAILABLE', 'Persistent approval store is unavailable.');
        return true;
      }
      const approval = formatApprovalRecord(runId && store.getToolApprovalById(runId, workspace.workspaceId));
      if (!approval || approval.tool !== 'http.ingest' || approvalWorkspace(approval) !== workspace.workspaceId) {
        failure(writeJson, req, res, 404, 'ingest-run-detail', 'INGEST_RUN_NOT_FOUND', 'Ingest run was not found in this workspace.');
        return true;
      }
      const run = buildIngestWorkflowRun(approval);
      if (!run) {
        failure(writeJson, req, res, 409, 'ingest-run-detail', 'INGEST_RUN_STATE_UNKNOWN', 'Ingest run state cannot be projected safely.');
        return true;
      }
      writeJson(req, res, 200, {
        workflowId: 'ingest-run-detail',
        ...workflowEnvelope({ ok: true, status: run.status, data: run, receiptId: run.receiptId }),
      }, NO_STORE);
      return true;
    }

    if (receiptMatch) {
      let receiptId;
      try { receiptId = decodeURIComponent(receiptMatch[1]); } catch (_) { receiptId = ''; }
      let read;
      try {
        read = receiptId && readReceipt(receiptId, { workspaceId: workspace.workspaceId });
      } catch (error) {
        reportInternalReceiptReadFailure(receiptId, error);
        read = { ok: false, status: 'read_error' };
      }
      if (!read || !read.ok) {
        const mapped = receiptReadFailure(read?.status || 'not_found');
        if (read?.error) reportInternalReceiptReadFailure(receiptId, read.error);
        failure(writeJson, req, res, mapped.statusCode, 'trust-receipt-detail', mapped.code,
          RECEIPT_READ_MESSAGES[mapped.code] || 'receipt could not be read');
        return true;
      }
      writeJson(req, res, 200, {
        workflowId: 'trust-receipt-detail',
        ...workflowEnvelope({ ok: true, status: 'completed', data: { receipt: read.receipt, workspaceId: workspace.workspaceId }, receiptId }),
      }, NO_STORE);
      return true;
    }

    const isDecision = reqUrl.pathname.endsWith('/decision');
    const rawId = approvalMatch[1] || '';
    let approvalId;
    try { approvalId = decodeURIComponent(rawId); } catch (_) { approvalId = ''; }
    const workflowId = isDecision ? 'approval-decision' : (approvalId ? 'approval-detail' : 'approvals');

    let store;
    try { store = getApprovalStore(); } catch (_) {
      failure(writeJson, req, res, 503, workflowId, 'APPROVAL_STORE_UNAVAILABLE', 'Persistent approval store is unavailable.');
      return true;
    }

    if (!approvalId) {
      const limit = Math.min(100, Math.max(1, Number(reqUrl.searchParams.get('limit')) || 50));
      const approvals = store.listUnresolvedToolApprovals(limit, workspace.workspaceId)
        .map(formatApprovalRecord)
        .filter(item => item && item.tool === 'http.ingest' && approvalWorkspace(item) === workspace.workspaceId);
      const windowTruncated = false;
      writeJson(req, res, 200, {
        workflowId,
        ...workflowEnvelope({ ok: true, status: 'completed', data: { approvals, total: approvals.length, windowTruncated, workspaceId: workspace.workspaceId } }),
      }, NO_STORE);
      return true;
    }

    const approval = formatApprovalRecord(store.getToolApprovalById(approvalId, workspace.workspaceId));
    if (!approval || approval.tool !== 'http.ingest' || approvalWorkspace(approval) !== workspace.workspaceId) {
      failure(writeJson, req, res, 404, workflowId, 'APPROVAL_NOT_FOUND', 'Approval was not found in this workspace.');
      return true;
    }

    if (!isDecision) {
      writeJson(req, res, 200, {
        workflowId,
        ...workflowEnvelope({ ok: true, status: 'completed', data: { approval, workspaceId: workspace.workspaceId } }),
      }, NO_STORE);
      return true;
    }

    const body = await parseJsonRequest(req, res, { maxBytes: 4_096 });
    if (!body) return true;
    const validationError = validateWorkflowHttpRequest('approval-decision', body);
    if (validationError) {
      failure(writeJson, req, res, 400, workflowId, 'INVALID_INPUT', validationError);
      return true;
    }
    const decision = String(body.decision || '').trim().toLowerCase();
    if (!['approved', 'rejected'].includes(decision)) {
      failure(writeJson, req, res, 400, workflowId, 'INVALID_APPROVAL_DECISION', 'decision approved|rejected is required.');
      return true;
    }
    const outcome = await decideApproval({ approvalId, workspaceId: workspace.workspaceId, decision, reason: String(body.reason || '') });
    if (outcome.error) {
      failure(writeJson, req, res, outcome.status, workflowId, outcome.error.code, outcome.error.message, outcome.error.details);
      return true;
    }
    const resolved = formatApprovalRecord(store.getToolApprovalById(approvalId, workspace.workspaceId));
    writeJson(req, res, outcome.status, {
      workflowId,
      ...workflowEnvelope({
        ok: true,
        status: decision === 'approved' && outcome.status === 202 ? 'queued' : 'completed',
        data: { ...outcome.json, approval: resolved || outcome.json?.approval || approval, workspaceId: workspace.workspaceId },
        receiptId: outcome.json?.receipt?.receiptId || null,
      }),
    }, NO_STORE);
    return true;
  };
}

module.exports = { createWorkflowDataRoutes };

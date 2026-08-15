'use strict';

const { workflowEnvelope } = require('./workflow-envelope');
const { formatApprovalRecord } = require('../mcp-approval-views');
const { readExactWorkspace } = require('./exact-workspace');
const { receiptReadFailure } = require('./receipt-read-failures');

const NO_STORE = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

function approvalWorkspace(approval) {
  return String(approval?.context?.snapshot?.workspaceId || approval?.context?.workspaceId || '');
}

function failure(writeJson, req, res, statusCode, workflowId, code, message) {
  writeJson(req, res, statusCode, {
    workflowId,
    ...workflowEnvelope({ ok: false, status: 'failed', error: { code, message } }),
  }, NO_STORE);
}

function createWorkflowDataRoutes({
  getApprovalStore,
  decideApproval,
  readReceipt,
  parseJsonRequest,
  writeJson,
}) {
  if (![getApprovalStore, decideApproval, readReceipt, parseJsonRequest, writeJson].every(fn => typeof fn === 'function')) {
    throw new TypeError('workflow data route dependencies are required');
  }

  return async function handleWorkflowDataRoute(req, res, reqUrl) {
    const approvalMatch = reqUrl.pathname.match(/^\/api\/v2\/approvals(?:\/([^/]+)(?:\/decision)?)?$/);
    const receiptMatch = reqUrl.pathname.match(/^\/api\/v2\/trust-receipts\/([^/]+)$/);
    if (!approvalMatch && !receiptMatch) return false;

    if (receiptMatch) {
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
      failure(writeJson, req, res, 400, approvalMatch ? 'approvals' : 'trust-receipt-detail', workspace.code,
        'Exactly one non-empty workspaceId is required.');
      return true;
    }

    if (receiptMatch) {
      let receiptId;
      try { receiptId = decodeURIComponent(receiptMatch[1]); } catch (_) { receiptId = ''; }
      const read = receiptId && readReceipt(receiptId, { workspaceId: workspace.workspaceId });
      if (!read || !read.ok) {
        const mapped = receiptReadFailure(read?.status || 'not_found');
        failure(writeJson, req, res, mapped.statusCode, 'trust-receipt-detail', mapped.code,
          read?.error?.message || 'receipt could not be read');
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
      const approvals = store.listUnresolvedToolApprovals(limit)
        .map(formatApprovalRecord)
        .filter(item => item && item.tool === 'http.ingest' && approvalWorkspace(item) === workspace.workspaceId);
      writeJson(req, res, 200, {
        workflowId,
        ...workflowEnvelope({ ok: true, status: 'completed', data: { approvals, total: approvals.length, workspaceId: workspace.workspaceId } }),
      }, NO_STORE);
      return true;
    }

    const approval = formatApprovalRecord(store.getToolApprovalById(approvalId));
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

    const body = await parseJsonRequest(req, res);
    if (!body) return true;
    const decision = String(body.decision || '').trim().toLowerCase();
    if (!['approved', 'rejected'].includes(decision)) {
      failure(writeJson, req, res, 400, workflowId, 'INVALID_APPROVAL_DECISION', 'decision approved|rejected is required.');
      return true;
    }
    const outcome = await decideApproval({ approvalId, decision, reason: String(body.reason || '') });
    if (outcome.error) {
      failure(writeJson, req, res, outcome.status, workflowId, outcome.error.code, outcome.error.message);
      return true;
    }
    const resolved = formatApprovalRecord(store.getToolApprovalById(approvalId));
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

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
const { canonicalMcpToolName } = require('../mcp-tool-names');
const { createMcpApprovalDecisionHandler } = require('../mcp-approval-decision-handler');
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

// H-01 (#1976): `/api/v2/workflows/learn` persists `huqan.learn` approvals
// (legacy rows carry `axiom.learn`), but every approvals seam below filtered
// `tool === 'http.ingest'`, so a learn proposal was creatable yet never
// listable, readable or decidable -- a ghost approval. Both workflow tools
// share this seam; the ingest-runs projection above stays `http.ingest`-only
// because it projects an ingest snapshot that learn rows do not have.
function isLearnApprovalTool(tool) {
  return canonicalMcpToolName(tool) === 'huqan.learn';
}

function isWorkflowApproval(item) {
  return !!item && (item.tool === 'http.ingest' || isLearnApprovalTool(item.tool));
}

// H-01 (#1976) learn karar adaptörü. `decideIngestApproval` ingest'e özgüdür
// (snapshot/lease/audit) ve `tool !== 'http.ingest'` satırını 404 ile
// reddeder; o yüzden learn satırları liste/karar filtresine eklenmekle
// kalmayıp araca uygun yürütücüye de bağlanmalıdır. Bu fabrika, CLI'ın
// `huqan.approve` yolunun kullandığı `handleMcpApprovalDecision`'ı (claim,
// `kernel.learn`, makbuzla kapatma) HTTP'nin `{ status, json } /
// { status, error }` sözleşmesine normalize eder. Aynı dosyada durur çünkü
// ayrı bir modül `package.json#files` kapanış listesine girmeyi
// gerektirirdi; karar mantığının kendisi zaten MCP tarafınındır, burası
// sadece taşıma uyarlamasıdır.
//
// Sınırlar:
//   - `http.ingest` satırlarına dokunmaz; onlar decideApproval'da kalır;
//   - runtime olarak yalnız `{ approvalStore }` verilir, Human Oversight
//     çalıştırılmaz (bu yüzeyden gelen learn önerileri `oversightRequired`
//     taşımaz; taşıyan olursa yürütücü fail-closed döner);
//   - ham MCP hata nesneleri dışarı çıkmaz, yalnız sınırlı kodlar.
function failLearnApprovalDecision(code, message, meta = {}) {
  return {
    ok: false,
    type: 'approval',
    data: null,
    evidence: [],
    error: { code, message },
    meta,
  };
}

const handleLearnApprovalDecision = createMcpApprovalDecisionHandler({ failApprovalDecision: failLearnApprovalDecision });

// Yürütücünün learn satırı için üretebildiği her kodun, onay seam'inin aynı
// durum için kullandığı HTTP karşılığı. Bilinmeyen kod fail-closed 400 olur,
// asla başarı sayılmaz.
function statusForLearnDecisionError(code) {
  switch (code) {
    case 'APPROVAL_STORE_UNAVAILABLE':
      return 503;
    case 'APPROVAL_NOT_FOUND':
      return 404;
    case 'APPROVAL_ALREADY_FINAL':
    case 'APPROVAL_DECISION_CONFLICT':
    case 'APPROVAL_EXECUTION_IN_PROGRESS':
    case 'APPROVAL_RECONCILIATION_REQUIRED':
    case 'APPROVAL_EXECUTION_FAILED':
    case 'APPROVAL_FINALIZATION_FAILED':
    case 'APPROVAL_EXECUTION_UNKNOWN':
    case 'OVERSIGHT_CASE_UNAVAILABLE':
    case 'OVERSIGHT_DECISION_FAILED':
    case 'OVERSIGHT_EXECUTION_BLOCKED':
    case 'OVERSIGHT_QUORUM_PENDING':
      return 409;
    case 'IDENTITY_ENFORCEMENT_BLOCKED':
      return 403;
    default:
      return 400;
  }
}

function createLearnApprovalDecision({ kernel, getApprovalStore }) {
  if (!kernel || typeof getApprovalStore !== 'function') {
    throw new TypeError('learn approval decision requires kernel and getApprovalStore');
  }
  return async ({ approvalId, workspaceId = 'default', decision, reason = '' }) => {
    let store;
    try {
      store = getApprovalStore();
    } catch (_) {
      return { status: 503, error: { code: 'APPROVAL_STORE_UNAVAILABLE', message: 'Persistent approval store is unavailable.' } };
    }
    let outcome;
    try {
      outcome = await handleLearnApprovalDecision(
        kernel,
        { approvalId, workspaceId, decision, reason },
        { approvalStore: store },
      );
    } catch (error) {
      return { status: 503, error: { code: 'APPROVAL_DECISION_FAILED', message: 'Learn approval decision failed.', details: { error: error?.code || error?.name || 'error' } } };
    }
    if (!outcome || outcome.ok !== true) {
      const code = outcome?.error?.code || 'APPROVAL_DECISION_FAILED';
      return {
        status: statusForLearnDecisionError(code),
        error: {
          code,
          message: outcome?.error?.message || 'Learn approval decision failed.',
          details: outcome?.meta || {},
        },
      };
    }
    return {
      status: 200,
      json: {
        ok: true,
        approval: outcome.data?.approval || null,
        receipt: outcome.data?.receipt || null,
        refs: outcome.data?.refs ?? null,
        executed: outcome.data?.executed === true,
        idempotent: outcome.data?.idempotent === true,
        decision: outcome.data?.decision || decision,
      },
    };
  };
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
  decideLearnApproval,
  readReceipt,
  parseJsonRequest,
  writeJson,
  proposeLearn,
  submitIngest,
  createAgent,
}) {
  if (![getApprovalStore, decideApproval, readReceipt, parseJsonRequest, writeJson, proposeLearn, submitIngest, createAgent].every(fn => typeof fn === 'function')) {
    throw new TypeError('workflow data route dependencies are required');
  }
  // Optional so existing callers (and their fixtures) keep working: when it
  // is absent, learn rows stay listable/readable but their decision fails
  // closed instead of running through the ingest executor.
  const decideLearn = typeof decideLearnApproval === 'function' ? decideLearnApproval : null;

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
      const provenance = bindHttpProvenance(body.provenance, {
        actor: 'http-api',
        workspaceId,
        sourceType: String(body.sourceType || '').trim() || 'manual',
        sourceRef: String(body.sourceRef || '').trim() || '/api/v2/workflows/learn',
        sourceTitle: String(body.sourceTitle || '').trim() || 'HTTP workflow learn',
      });
      const proposal = await proposeLearn({ text: inputText, workspaceId, provenance });
      const approval = proposal?.approval || null;
      if (!approval || approval.persisted !== true || !approval.id) {
        failure(writeJson, req, res, 503, 'learn-review', 'REVIEW_NOT_PERSISTED',
          'Learn requires review, but no durable approval was recorded; nothing was queued and nothing executed.');
        return true;
      }
      writeJson(req, res, 202, {
        workflowId: 'learn-review',
        ...workflowEnvelope({
          ok: false,
          status: 'review_required',
          data: {
            learned: 0,
            approval,
            approvalId: approval.id,
            candidateId: approval.context?.candidateId || null,
            provenance: approval.context?.provenance || provenance,
            policy: proposal.gate || proposal.policy || null,
            workspaceId,
          },
        }),
        approval,
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
        .filter(item => isWorkflowApproval(item) && approvalWorkspace(item) === workspace.workspaceId);
      const windowTruncated = false;
      writeJson(req, res, 200, {
        workflowId,
        ...workflowEnvelope({ ok: true, status: 'completed', data: { approvals, total: approvals.length, windowTruncated, workspaceId: workspace.workspaceId } }),
      }, NO_STORE);
      return true;
    }

    const approval = formatApprovalRecord(store.getToolApprovalById(approvalId, workspace.workspaceId));
    if (!approval || !isWorkflowApproval(approval) || approvalWorkspace(approval) !== workspace.workspaceId) {
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
    // Tool-correct executor (H-01): ingest rows keep their snapshot/lease/audit
    // owner, learn rows run through the MCP learn decision. Sending a learn
    // row into decideIngestApproval would 404 at best and mis-execute at
    // worst, so an unconfigured learn executor fails closed instead.
    const decide = isLearnApprovalTool(approval.tool) ? decideLearn : decideApproval;
    if (!decide) {
      failure(writeJson, req, res, 503, workflowId, 'APPROVAL_DECISION_UNAVAILABLE', 'Learn approval decision is not configured.');
      return true;
    }
    const outcome = await decide({ approvalId, workspaceId: workspace.workspaceId, decision, reason: String(body.reason || '') });
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
        // The decision produces two identifiers, and only one of them can be
        // read back. `receipt.receiptId` is the approval-flow receipt, which
        // lives in the approval row's context and is deliberately excluded from
        // the materialized read index (see collectMaterializedReceiptEntries);
        // `trustReceiptId` names the receipt the audit trail materialized.
        // Publishing the approval one sent every consumer -- the dashboard's
        // recent list included -- to look up an id no lookup mode can resolve.
        receiptId: outcome.json?.trustReceiptId || outcome.json?.receipt?.receiptId || null,
      }),
    }, NO_STORE);
    return true;
  };
}

module.exports = { createWorkflowDataRoutes, createLearnApprovalDecision, statusForLearnDecisionError };

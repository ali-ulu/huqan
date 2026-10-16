'use strict';

const { canonicalMcpToolName } = require('../mcp-tool-names');
const { createMcpApprovalDecisionHandler } = require('../mcp-approval-decision-handler');

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
// #2189: one row per code; a new executor or oversight code is a row, not a
// case. No prototype, so an inherited key never resolves to a status.
const LEARN_DECISION_ERROR_STATUS = Object.freeze(Object.assign(Object.create(null), {
  APPROVAL_STORE_UNAVAILABLE: 503,
  APPROVAL_NOT_FOUND: 404,
  APPROVAL_ALREADY_FINAL: 409,
  APPROVAL_DECISION_CONFLICT: 409,
  APPROVAL_EXECUTION_IN_PROGRESS: 409,
  APPROVAL_RECONCILIATION_REQUIRED: 409,
  APPROVAL_EXECUTION_FAILED: 409,
  APPROVAL_FINALIZATION_FAILED: 409,
  APPROVAL_EXECUTION_UNKNOWN: 409,
  OVERSIGHT_CASE_UNAVAILABLE: 409,
  OVERSIGHT_DECISION_FAILED: 409,
  OVERSIGHT_EXECUTION_BLOCKED: 409,
  OVERSIGHT_QUORUM_PENDING: 409,
  IDENTITY_ENFORCEMENT_BLOCKED: 403,
}));

function statusForLearnDecisionError(code) {
  return typeof code === 'string' && Object.hasOwn(LEARN_DECISION_ERROR_STATUS, code)
    ? LEARN_DECISION_ERROR_STATUS[code]
    : 400;
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

module.exports = {
  approvalWorkspace,
  isLearnApprovalTool,
  isWorkflowApproval,
  reportInternalReceiptReadFailure,
  RECEIPT_READ_MESSAGES,
  createLearnApprovalDecision,
  statusForLearnDecisionError,
};

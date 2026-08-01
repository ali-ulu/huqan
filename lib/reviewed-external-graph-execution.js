'use strict';

const { isDeepStrictEqual } = require('node:util');
const { sha256 } = require('./ingest');
const { appendReceiptToChain } = require('./receipt/receipt-chain');
const {
  failure, exact, without, printable, canonicalTime,
  validatePlan, validateReservation, validateTrust,
} = require('./reviewed-external-graph-contract');

const EXECUTION_VERSION = 'huqan.reviewed-external-graph-execution.v1';
const RESULT_VERSION = 'huqan.reviewed-external-graph-result.v1';
const RECEIPT_VERSION = 'huqan.reviewed-external-graph-receipt.v1';
const FINALIZATION_VERSION = 'huqan.reviewed-external-graph-finalization.v1';
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const CLAIM_KEYS = new Set(['version','operationId','receiptId','approvalId','reservationHash','candidatePlanHash','workspaceId','leaseOwner','startedAt','approvalUpdatedAt','executionHash']);
const RESULT_KEYS = new Set(['version','operationId','approvalId','reservationHash','candidatePlanHash','workspaceId','candidateCount','nodeCount','edgeCount']);
const RECEIPT_RECORD_KEYS = new Set(['operationId','receiptId','workspaceId','canonicalPayload','previousReceiptHash','receiptHash','committedAt']);
const RECEIPT_PAYLOAD_KEYS = new Set(['version','receiptId','operationId','workspaceId','approvalId','reservationHash','admissionHash','candidatePlanHash','executionHash','sourceType','sourceRef','immutableSourceId','requester','reviewer','selfApproval','documentCount','sectionCount','candidateCount','resultHash','startedAt']);
const FINAL_KEYS = new Set(['version','operationId','receiptId','reservationHash','candidatePlanHash','graphReceiptHash','resultHash','completedAt','approvalUpdatedAt','finalizationHash']);

function operationIdentity(reservation) {
  const suffix = reservation.reservationHash.slice('sha256:'.length);
  return { operationId:`reviewed-external-graph:${suffix}`, receiptId:`reviewed-external-receipt:${suffix}` };
}
function recordIdentity(record, plan) {
  if (!record || record.id !== plan.approvalId || record.approval_key !== plan.approvalKey || record.tool !== 'http.ingest') return failure('REVIEWED_GRAPH_RECORD_IDENTITY_MISMATCH', 'approval identity does not match');
  if (!printable(record.context_json, 1_000_000) || !Number.isSafeInteger(Number(record.updated_at))) return failure('REVIEWED_GRAPH_RECORD_METADATA_INVALID', 'approval metadata is invalid');
  return { ok:true };
}
function validateLease(record, reservation, now) {
  const claim = record.context?.executionClaim;
  if (!claim || claim.owner !== reservation.leaseOwner || Number(claim.leaseExpiresAt) !== reservation.leaseExpiresAt || !Number.isSafeInteger(Number(claim.claimedAt))) return failure('REVIEWED_GRAPH_CLAIM_MISMATCH', 'execution claim does not match reservation');
  return now >= reservation.leaseExpiresAt ? failure('REVIEWED_GRAPH_LEASE_EXPIRED', 'execution lease expired') : { ok:true };
}
function buildExecutionClaim(plan, reservation, now, ids) {
  const value = { version:EXECUTION_VERSION, ...ids, approvalId:plan.approvalId, reservationHash:reservation.reservationHash, candidatePlanHash:plan.candidatePlanHash, workspaceId:plan.workspaceId, leaseOwner:plan.leaseOwner, startedAt:now.text, approvalUpdatedAt:Math.max(now.millis,reservation.approvalUpdatedAt+1) };
  return { ...value, executionHash:sha256(value) };
}
function validateExecutionClaim(claim, plan, reservation, ids) {
  if (!exact(claim, CLAIM_KEYS) || claim.version !== EXECUTION_VERSION || claim.operationId !== ids.operationId || claim.receiptId !== ids.receiptId
    || claim.approvalId !== plan.approvalId || claim.reservationHash !== reservation.reservationHash || claim.candidatePlanHash !== plan.candidatePlanHash
    || claim.workspaceId !== plan.workspaceId || claim.leaseOwner !== plan.leaseOwner || !canonicalTime(claim.startedAt).ok
    || !Number.isSafeInteger(claim.approvalUpdatedAt) || claim.approvalUpdatedAt <= reservation.approvalUpdatedAt
    || sha256(without(claim,'executionHash')) !== claim.executionHash) return failure('REVIEWED_GRAPH_EXECUTION_CLAIM_INVALID', 'graph execution claim is invalid');
  return { ok:true };
}
function validateResult(result, plan, reservation, claim) {
  const expectedNodes = 1 + plan.documentCount + plan.sectionCount;
  const expectedEdges = plan.documentCount + plan.sectionCount;
  if (!exact(result, RESULT_KEYS) || result.version !== RESULT_VERSION || result.operationId !== claim.operationId
    || result.approvalId !== plan.approvalId || result.reservationHash !== reservation.reservationHash
    || result.candidatePlanHash !== plan.candidatePlanHash || result.workspaceId !== plan.workspaceId
    || result.candidateCount !== plan.candidateCount || result.nodeCount !== expectedNodes || result.edgeCount !== expectedEdges) {
    return failure('REVIEWED_GRAPH_RESULT_INVALID', 'durable graph result is invalid');
  }
  return { ok:true };
}

function mutateGraph(graph, plan, reservation, claim) {
  let nodeCount = 0; let edgeCount = 0;
  for (const item of plan.candidates) {
    const provenance = { provenanceId:sha256({reservationHash:reservation.reservationHash,candidateId:item.candidateId}), sourceType:item.sourceType, sourceRef:item.sourceRef, sourceTitle:item.sourceTitle, sourceSubType:item.sourceSubType, actor:plan.requester, timestamp:claim.startedAt, workspaceId:plan.workspaceId, immutableSourceId:plan.immutableSourceId, approvalId:plan.approvalId, reservationHash:reservation.reservationHash };
    if (item.kind === 'node') {
      if (!graph.addNode(item.nodeId,item.label,provenance,{workspaceId:plan.workspaceId})) throw new Error('node mutation failed');
      nodeCount += 1;
    } else {
      if (!graph.addEdge(item.fromId,item.toId,item.relation,{workspaceId:plan.workspaceId,weight:item.confidence,confidence:item.confidence,source:'reviewed_external_ingest',sourceRef:item.sourceRef,sessionId:claim.operationId,evidence:[...item.evidence],evidenceType:'reviewed_external_source',sourceType:item.sourceType,createdAt:claim.startedAt,provenance})) throw new Error('edge mutation failed');
      edgeCount += 1;
    }
  }
  return { version:RESULT_VERSION, operationId:claim.operationId, approvalId:plan.approvalId, reservationHash:reservation.reservationHash, candidatePlanHash:plan.candidatePlanHash, workspaceId:plan.workspaceId, candidateCount:plan.candidateCount, nodeCount, edgeCount };
}
function buildReceipt(plan, reservation, claim, result) {
  return { version:RECEIPT_VERSION, receiptId:claim.receiptId, operationId:claim.operationId, workspaceId:plan.workspaceId, approvalId:plan.approvalId, reservationHash:reservation.reservationHash, admissionHash:reservation.admissionHash, candidatePlanHash:plan.candidatePlanHash, executionHash:claim.executionHash, sourceType:plan.sourceType, sourceRef:plan.sourceRef, immutableSourceId:plan.immutableSourceId, requester:plan.requester, reviewer:plan.reviewer, selfApproval:plan.selfApproval, documentCount:plan.documentCount, sectionCount:plan.sectionCount, candidateCount:plan.candidateCount, resultHash:sha256(result), startedAt:claim.startedAt };
}
function validateReceipt(receipt, plan, reservation, claim, result) {
  const payload = receipt?.canonicalPayload;
  let chained = null;
  try { chained = appendReceiptToChain(payload, receipt?.previousReceiptHash); } catch (_) {}
  if (!exact(receipt, RECEIPT_RECORD_KEYS) || !exact(payload, RECEIPT_PAYLOAD_KEYS)
    || receipt.operationId !== claim.operationId || receipt.receiptId !== claim.receiptId || receipt.workspaceId !== plan.workspaceId
    || !SHA256.test(receipt.receiptHash) || !printable(receipt.previousReceiptHash,256) || !canonicalTime(receipt.committedAt).ok
    || chained?.receiptHash !== receipt.receiptHash
    || payload.version !== RECEIPT_VERSION || payload.receiptId !== claim.receiptId || payload.operationId !== claim.operationId || payload.workspaceId !== plan.workspaceId
    || payload.approvalId !== plan.approvalId || payload.reservationHash !== reservation.reservationHash || payload.admissionHash !== reservation.admissionHash
    || payload.candidatePlanHash !== plan.candidatePlanHash || payload.executionHash !== claim.executionHash
    || payload.sourceType !== plan.sourceType || payload.sourceRef !== plan.sourceRef || payload.immutableSourceId !== plan.immutableSourceId
    || payload.requester !== plan.requester || payload.reviewer !== plan.reviewer || payload.selfApproval !== plan.selfApproval
    || payload.documentCount !== plan.documentCount || payload.sectionCount !== plan.sectionCount || payload.candidateCount !== plan.candidateCount
    || payload.resultHash !== sha256(result) || payload.startedAt !== claim.startedAt) return failure('REVIEWED_GRAPH_RECEIPT_INVALID', 'durable graph receipt is invalid');
  return { ok:true };
}
function buildFinalization(plan, reservation, claim, receipt, result, now) {
  const value = { version:FINALIZATION_VERSION, operationId:claim.operationId, receiptId:claim.receiptId, reservationHash:reservation.reservationHash, candidatePlanHash:plan.candidatePlanHash, graphReceiptHash:receipt.receiptHash, resultHash:sha256(result), completedAt:receipt.committedAt, approvalUpdatedAt:Math.max(now,claim.approvalUpdatedAt+1) };
  return { ...value, finalizationHash:sha256(value) };
}
function validateFinalization(value, plan, reservation, claim, receipt, result) {
  if (!exact(value, FINAL_KEYS) || value.version !== FINALIZATION_VERSION || value.operationId !== claim.operationId || value.receiptId !== claim.receiptId
    || value.reservationHash !== reservation.reservationHash || value.candidatePlanHash !== plan.candidatePlanHash || value.graphReceiptHash !== receipt.receiptHash
    || value.resultHash !== sha256(result) || value.completedAt !== receipt.committedAt || !canonicalTime(value.completedAt).ok
    || !Number.isSafeInteger(value.approvalUpdatedAt) || value.approvalUpdatedAt <= claim.approvalUpdatedAt
    || sha256(without(value,'finalizationHash')) !== value.finalizationHash) return failure('REVIEWED_GRAPH_FINALIZATION_INVALID', 'graph finalization is invalid');
  return { ok:true };
}
function validateApprovedState(record, plan, reservation, claim, receipt, result) {
  const finalization = record.context?.reviewedExternalGraphFinalization;
  const checked = validateFinalization(finalization,plan,reservation,claim,receipt,result);
  if (!checked.ok) return checked;
  if (record.status !== 'approved' || record.decision !== 'approved' || record.reason !== 'reviewed_external_graph_committed'
    || Number(record.decided_at) !== finalization.approvalUpdatedAt || Number(record.updated_at) !== finalization.approvalUpdatedAt
    || !isDeepStrictEqual(record.context?.reviewedExternalAdmissionReservation,reservation)
    || !isDeepStrictEqual(record.context?.reviewedExternalGraphExecution,claim)) {
    return failure('REVIEWED_GRAPH_FINALIZED_STATE_INVALID', 'approved outcome binding is incomplete');
  }
  return { ok:true };
}

function executeReviewedExternalGraphMutation(plan, reservation, options = {}) {
  for (const check of [validatePlan(plan), validateReservation(plan,reservation), validateTrust(plan,reservation,options)]) if (!check.ok) return check;
  const store = options.approvalStore; const graph = options.graph;
  if (!store?.db?.prepare || typeof store.getToolApprovalById !== 'function') return failure('REVIEWED_GRAPH_STORE_REQUIRED', 'persistent SQLite approval store is required');
  let graphStats;
  try { graphStats = typeof graph?.getStats === 'function' ? graph.getStats() : null; }
  catch (_) { return failure('REVIEWED_GRAPH_BACKEND_REQUIRED', 'durable SQLite graph is required'); }
  if (graphStats?.backend !== 'sqlite' || typeof graph.runMutationOnce !== 'function' || typeof graph.getCommittedMutationReceiptByOperation !== 'function' || typeof graph.addNode !== 'function' || typeof graph.addEdge !== 'function') return failure('REVIEWED_GRAPH_BACKEND_REQUIRED', 'durable SQLite graph is required');
  const now = canonicalTime(options.now); const reservedAt = canonicalTime(reservation.reservedAt);
  if (!now.ok) return failure('REVIEWED_GRAPH_NOW_INVALID', 'trusted execution time is invalid');
  if (!reservedAt.ok || now.millis < reservedAt.millis || now.millis < reservation.approvalUpdatedAt) return failure('REVIEWED_GRAPH_NOT_YET_VALID', 'execution predates reservation');
  const ids = operationIdentity(reservation);
  let record; try { record = store.getToolApprovalById(plan.approvalId); } catch (_) { return failure('REVIEWED_GRAPH_STORE_READ_FAILED', 'approval read failed'); }
  let checked = recordIdentity(record,plan); if (!checked.ok) return checked;
  let claim = record.context?.reviewedExternalGraphExecution || null;
  let receipt; try { receipt = graph.getCommittedMutationReceiptByOperation(ids.operationId); } catch (_) { return failure('REVIEWED_GRAPH_RECEIPT_READ_FAILED', 'graph receipt read failed'); }

  if (record.status === 'approved') {
    if (!claim || !receipt || !record.context?.reviewedExternalGraphFinalization) return failure('REVIEWED_GRAPH_FINALIZED_STATE_INVALID', 'approved outcome binding is incomplete');
    checked = validateExecutionClaim(claim,plan,reservation,ids); if (!checked.ok) return checked;
    let replay; try { replay = graph.runMutationOnce(ids.operationId,()=>{ throw new Error('must replay'); }); } catch (_) { return failure('REVIEWED_GRAPH_JOURNAL_READ_FAILED', 'graph journal replay failed'); }
    checked = validateResult(replay.result,plan,reservation,claim); if (!checked.ok) return checked;
    checked = validateReceipt(receipt,plan,reservation,claim,replay.result); if (!checked.ok) return checked;
    checked = validateApprovedState(record,plan,reservation,claim,receipt,replay.result); if (!checked.ok) return checked;
    return { ok:true, replayed:true, result:replay.result, receipt, approval:record };
  }
  if (record.status !== 'executing' || record.decision !== 'approved' || Number(record.decided_at) !== 0) return failure('REVIEWED_GRAPH_RECORD_STATE_INVALID', 'approval is not executing');
  if (!isDeepStrictEqual(record.context?.reviewedExternalAdmissionReservation,reservation)) return failure('REVIEWED_GRAPH_RESERVATION_RECORD_MISMATCH', 'persisted reservation does not match');
  if (receipt && !claim) return failure('REVIEWED_GRAPH_RECEIPT_WITHOUT_CLAIM', 'graph receipt exists without execution claim');

  if (claim) {
    checked = validateExecutionClaim(claim,plan,reservation,ids); if (!checked.ok) return checked;
    if (Number(record.updated_at) !== claim.approvalUpdatedAt) return failure('REVIEWED_GRAPH_RECORD_CHANGED', 'approval changed after graph claim');
  } else {
    if (Number(record.updated_at) !== reservation.approvalUpdatedAt) return failure('REVIEWED_GRAPH_RECORD_CHANGED', 'approval changed after reservation');
    checked = validateLease(record,reservation,now.millis); if (!checked.ok) return checked;
    claim = buildExecutionClaim(plan,reservation,now,ids);
    const nextContext = { ...record.context, reviewedExternalGraphExecution:claim };
    let result;
    try {
      result = store.db.prepare(`UPDATE tool_approvals SET context_json=@context_json,reason=@reason,updated_at=@updated_at WHERE id=@id AND approval_key=@approval_key AND tool='http.ingest' AND status='executing' AND decision='approved' AND decided_at=0 AND updated_at=@expected_updated_at AND context_json=@expected_context_json AND CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)<@lease_expires_at`).run({ id:plan.approvalId, approval_key:plan.approvalKey, context_json:JSON.stringify(nextContext), reason:'reviewed_external_graph_execution_claimed', updated_at:claim.approvalUpdatedAt, expected_updated_at:reservation.approvalUpdatedAt, expected_context_json:record.context_json, lease_expires_at:reservation.leaseExpiresAt });
    } catch (_) { return failure('REVIEWED_GRAPH_EXECUTION_CLAIM_WRITE_FAILED', 'graph claim write failed'); }
    if (Number(result?.changes || 0) !== 1) return failure('REVIEWED_GRAPH_EXECUTION_CLAIM_CAS_FAILED', 'graph claim CAS failed');
    try { record = store.getToolApprovalById(plan.approvalId); } catch (_) { return failure('REVIEWED_GRAPH_STORE_READ_FAILED', 'graph claim readback failed'); }
    checked = recordIdentity(record,plan); if (!checked.ok) return checked;
    if (record.status !== 'executing' || record.decision !== 'approved' || Number(record.decided_at) !== 0
      || Number(record.updated_at) !== claim.approvalUpdatedAt
      || !isDeepStrictEqual(record.context?.reviewedExternalAdmissionReservation,reservation)
      || !isDeepStrictEqual(record.context?.reviewedExternalGraphExecution,claim)) {
      return failure('REVIEWED_GRAPH_EXECUTION_CLAIM_READBACK_INVALID', 'persisted graph claim could not be verified');
    }
  }

  if (!receipt) {
    checked = validateLease(record,reservation,now.millis); if (!checked.ok) return checked;
    let execution;
    try { execution = graph.runMutationOnce(claim.operationId,()=>mutateGraph(graph,plan,reservation,claim),{buildCanonicalReceipt:result=>buildReceipt(plan,reservation,claim,result)}); }
    catch (_) { return failure('REVIEWED_GRAPH_MUTATION_FAILED', 'reviewed graph mutation did not commit'); }
    receipt = execution.receipt || graph.getCommittedMutationReceiptByOperation(claim.operationId);
  }
  let replay; try { replay = graph.runMutationOnce(claim.operationId,()=>{ throw new Error('must replay'); }); }
  catch (_) { return failure('REVIEWED_GRAPH_JOURNAL_READ_FAILED', 'graph journal replay failed'); }
  checked = validateResult(replay.result,plan,reservation,claim); if (!checked.ok) return checked;
  checked = validateReceipt(receipt,plan,reservation,claim,replay.result); if (!checked.ok) return checked;

  try { record = store.getToolApprovalById(plan.approvalId); } catch (_) { return failure('REVIEWED_GRAPH_STORE_READ_FAILED', 'approval finalization read failed'); }
  checked = recordIdentity(record,plan); if (!checked.ok) return checked;
  if (record.status === 'approved' && record.context?.reviewedExternalGraphFinalization) {
    checked = validateApprovedState(record,plan,reservation,claim,receipt,replay.result);
    return checked.ok ? {ok:true,replayed:true,result:replay.result,receipt,approval:record} : checked;
  }
  if (record.status !== 'executing' || record.decision !== 'approved' || Number(record.decided_at) !== 0 || Number(record.updated_at) !== claim.approvalUpdatedAt
    || !isDeepStrictEqual(record.context?.reviewedExternalAdmissionReservation,reservation)
    || !isDeepStrictEqual(record.context?.reviewedExternalGraphExecution,claim)) return failure('REVIEWED_GRAPH_FINALIZATION_STATE_CHANGED', 'approval changed before finalization');
  const finalization = buildFinalization(plan,reservation,claim,receipt,replay.result,now.millis);
  const context = { ...record.context, reviewedExternalGraphFinalization:finalization };
  let finalResult;
  try {
    finalResult = store.db.prepare(`UPDATE tool_approvals SET status='approved',decision='approved',reason=@reason,context_json=@context_json,decided_at=@decided_at,updated_at=@updated_at WHERE id=@id AND approval_key=@approval_key AND tool='http.ingest' AND status='executing' AND decision='approved' AND decided_at=0 AND updated_at=@expected_updated_at AND context_json=@expected_context_json`).run({ id:plan.approvalId, approval_key:plan.approvalKey, reason:'reviewed_external_graph_committed', context_json:JSON.stringify(context), decided_at:finalization.approvalUpdatedAt, updated_at:finalization.approvalUpdatedAt, expected_updated_at:claim.approvalUpdatedAt, expected_context_json:record.context_json });
  } catch (_) { return failure('REVIEWED_GRAPH_FINALIZATION_WRITE_FAILED', 'graph finalization write failed'); }
  if (Number(finalResult?.changes || 0) !== 1) return failure('REVIEWED_GRAPH_FINALIZATION_CAS_FAILED', 'graph finalization CAS failed');
  let approval; try { approval = store.getToolApprovalById(plan.approvalId); } catch (_) { return failure('REVIEWED_GRAPH_STORE_READ_FAILED', 'finalized approval read failed'); }
  checked = recordIdentity(approval,plan);
  if (!checked.ok) return checked;
  checked = validateApprovedState(approval,plan,reservation,claim,receipt,replay.result);
  if (!checked.ok) return failure('REVIEWED_GRAPH_FINALIZATION_READBACK_INVALID', 'finalized approval could not be verified');
  return { ok:true, replayed:false, result:replay.result, receipt, approval };
}

module.exports = {
  REVIEWED_EXTERNAL_GRAPH_EXECUTION_VERSION:EXECUTION_VERSION,
  REVIEWED_EXTERNAL_GRAPH_RESULT_VERSION:RESULT_VERSION,
  REVIEWED_EXTERNAL_GRAPH_RECEIPT_VERSION:RECEIPT_VERSION,
  REVIEWED_EXTERNAL_GRAPH_FINALIZATION_VERSION:FINALIZATION_VERSION,
  executeReviewedExternalGraphMutation,
};

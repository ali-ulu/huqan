'use strict';

// What an MCP call returns when the gate will not let it execute: queued for
// review, previewed as a dry run, or blocked (#2142).

const { saveMcpApproval, createApprovalStoreFromKernel } = require('../mcp-approval-store');
const { getHumanOversightRuntime, createMcpOversightCase } = require('../mcp-approval-decision-handler');
const { withMcpToolVerdictSurface } = require('./response-builders');

function gateSurface(gate) {
  return {
    decision: gate.decision,
    allowed: gate.allowed,
    canExecute: gate.canExecute,
    canDryRun: gate.canDryRun,
    requiredReview: gate.requiredReview,
    reason: gate.reason,
    metadata: { policyVersion: gate.metadata?.adapterVersion || 'V2.6-PR2' },
  };
}

function queueForReview({ kernel, name, args, gate, runtime }) {
  const approvalStore = runtime.approvalStore || createApprovalStoreFromKernel(kernel, runtime);
  const approval = saveMcpApproval(approvalStore, name, args, gate, {
    oversightRequired: Boolean(getHumanOversightRuntime(runtime)) && name === 'huqan.learn',
  });
  const surface = gateSurface(gate);
  // "Queued for review" is a claim about durable state. Without a stored
  // approval there is no queue and no one to review it, so the caller is
  // told that instead -- the mutation is blocked either way (#772).
  if (approval.persisted !== true) {
    return withMcpToolVerdictSurface({
      ok: false,
      gate: surface,
      approval,
      error: {
        code: 'REVIEW_NOT_PERSISTED',
        reason: approval.notPersistedReason || 'approval_store_unavailable',
        message: 'Tool call requires review, but no durable approval was recorded; nothing was queued and nothing executed.',
      },
      message: `Tool call blocked, review not persisted: ${gate.reason}`,
    }, name, args, gate);
  }
  const oversightCase = createMcpOversightCase({
    runtime,
    approval,
    toolName: name,
    storedArgs: approval.context?.args || args,
    gate,
  });
  const approvalSurface = oversightCase.enabled
    ? { ...approval, oversight: oversightCase.summary || { caseId: '', status: 'unavailable' } }
    : approval;
  if (oversightCase.enabled && !oversightCase.ok) {
    return withMcpToolVerdictSurface({
      ok: false,
      gate: surface,
      approval: approvalSurface,
      error: {
        code: 'REVIEW_CASE_NOT_PERSISTED',
        reason: oversightCase.result?.reason || 'oversight_case_creation_failed',
        message: 'Tool call requires Human Oversight, but no durable review case was recorded; nothing executed.',
      },
      message: 'Tool call blocked because the Human Oversight review case was not durably recorded.',
    }, name, args, gate);
  }
  const ingestExecuteData = name === 'huqan.ingest_execute'
    ? {
      approval,
      approvalId: approval.id || '',
      // huqan.ingest_status requires `runId` and its schema describes it as
      // "Run identifier returned by ingest execute" -- but this response
      // carried the value only as `approvalId`, so the advertised
      // preview -> execute -> status flow ended with a caller holding no
      // field by the name the next call asks for. The HTTP surface already
      // emits both (lib/http/workflow-data-routes.js), so this is the MCP
      // side catching up rather than a new field: same value, same source,
      // `approvalId` kept for anything already reading it.
      runId: approval.id || '',
      statusRoute: approval.id ? `/api/v2/ingest/runs/${approval.id}` : '',
      queuedForExecution: approval.persisted === true,
      result: null,
      receipt: null,
      refs: null,
    }
    : null;
  return withMcpToolVerdictSurface({
    ok: false,
    gate: surface,
    approval: approvalSurface,
    ...(ingestExecuteData ? { data: { ...ingestExecuteData, approval: approvalSurface } } : {}),
    message: `Tool call queued for review: ${gate.reason}`,
  }, name, args, gate);
}

/** The answer for a call the gate refused to execute (`gate.canExecute === false`). */
function respondToGateRefusal({ kernel, name, args, gate, runtime, executeReadOnlyDryRun }) {
  if (gate.decision === 'review' || gate.requiredReview) {
    return queueForReview({ kernel, name, args, gate, runtime });
  }
  if (gate.canDryRun) {
    const dryRunResult = executeReadOnlyDryRun(kernel, name, args);
    return withMcpToolVerdictSurface({
      ok: true,
      dryRun: true,
      gate: gateSurface(gate),
      result: dryRunResult,
      message: `Tool dry-run: ${gate.reason}`,
    }, name, args, gate);
  }
  return withMcpToolVerdictSurface({
    ok: false,
    gate: gateSurface(gate),
    message: `Tool call blocked by gate: ${gate.reason}`,
  }, name, args, gate);
}

module.exports = {
  respondToGateRefusal,
};

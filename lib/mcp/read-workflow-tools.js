'use strict';

const { runReadWorkflow, NO_CAPABILITY_ENSURE } = require('../http/read-workflow-actions');
const { buildTrustReceipt } = require('../provenance-query');
const { hasTrustQuery } = require('../http-trust-query');
const { sanitizeMcpString } = require('../mcp-input-sanitizers');
const { withMcpToolVerdictSurface } = require('./response-builders');

const READ_WORKFLOW_TOOLS = new Set(['huqan.advocate', 'huqan.search', 'huqan.trust_receipt']);

function executeMcpVerify({ kernel, name, args, gate }) {
  const statement = sanitizeMcpString(args.statement);
  const workspaceId = sanitizeMcpString(args.workspaceId);
  const result = workspaceId ? kernel.verify(statement, { workspaceId }) : kernel.verify(statement);
  return withMcpToolVerdictSurface(result, name, args, gate);
}

function executeMcpReadWorkflow({ kernel, name, args, gate }) {
  if (!READ_WORKFLOW_TOOLS.has(name)) return null;

  if (name === 'huqan.advocate' || name === 'huqan.search') {
    const workflowId = name === 'huqan.advocate' ? 'advocate' : 'memory-search';
    // Stated, not omitted: this surface's kernel is built with
    // loadPlugins: false on purpose, because a plugin is require()d into the
    // host process with full privileges and MCP is the model-driven surface
    // (THREAT_MODEL.md, "Plugin Code Execution"). advocate therefore answers
    // capability_not_available here, deliberately (#2001).
    return Promise.resolve(runReadWorkflow({
      workflowId, kernel, input: args, ensureCapabilities: NO_CAPABILITY_ENSURE,
    })).then(({ body }) => (
      withMcpToolVerdictSurface(body, name, args, gate)
    ));
  }

  const workspaceId = sanitizeMcpString(args.workspaceId, 128);
  const filters = {
    workspaceId,
    targetId: sanitizeMcpString(args.targetId, 128),
    provenanceId: sanitizeMcpString(args.provenanceId, 128),
    sourceRef: sanitizeMcpString(args.sourceRef, 256),
    candidateId: sanitizeMcpString(args.candidateId, 128),
    eventType: sanitizeMcpString(args.eventType, 32),
  };
  if (!workspaceId || !hasTrustQuery(filters, ['targetId', 'provenanceId', 'sourceRef', 'candidateId', 'eventType'])) {
    return withMcpToolVerdictSurface({
      ok: false,
      data: null,
      evidence: [],
      error: { code: 'INVALID_INPUT', message: 'workspaceId and one trust receipt filter are required.' },
      meta: {},
    }, name, args, gate);
  }

  const receipt = buildTrustReceipt(filters, { target: kernel.graph });
  return withMcpToolVerdictSurface({
    ok: true,
    type: 'trust_receipt',
    data: receipt,
    evidence: [],
    receiptId: receipt.receiptId,
    error: null,
    meta: {},
  }, name, args, gate);
}

module.exports = { READ_WORKFLOW_TOOLS, executeMcpVerify, executeMcpReadWorkflow };

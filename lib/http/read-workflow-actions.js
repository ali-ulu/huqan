'use strict';

const { workflowEnvelope } = require('./workflow-envelope');

const MAX_SEARCH_RESULTS = 50;

function text(value, max = 4_000) {
  return String(value || '').trim().slice(0, max);
}

function completed(result, overrides = {}) {
  return workflowEnvelope({
    ok: true,
    status: 'completed',
    data: result?.data ?? result ?? null,
    evidence: result?.evidence,
    confidence: result?.data?.confidence ?? result?.confidence,
    receiptId: result?.receiptId ?? result?.data?.receiptId,
    ...overrides,
  });
}

function invalid(message) {
  return {
    statusCode: 400,
    body: workflowEnvelope({
      ok: false,
      status: 'failed',
      error: { code: 'INVALID_INPUT', message },
    }),
  };
}

function assertInput(input, fieldNames) {
  for (const field of fieldNames) {
    const value = text(input?.[field]);
    if (value) return value;
  }
  return '';
}

/**
 * A workflow this surface cannot serve because the capability behind it is not
 * enabled here, as opposed to one that does not exist at all.
 *
 * `advocate` is the case that made this necessary. It runs as a *plugin*
 * capability, and the two surfaces that reach this module do not agree on
 * plugins: `server.js` enables `pluginCapabilities` and loads the plugins
 * directory through `ensureCapabilities`, while `mcpServer.js` builds its
 * kernel with `loadPlugins: false` (`lib/mcp-approval-store.js`). That is a
 * deliberate boundary, not an omission -- a plugin is `require()`d into the
 * host process with full privileges and no sandbox (THREAT_MODEL.md, "Plugin
 * Code Execution"), and the MCP surface is the model-driven one.
 *
 * What was wrong was not the boundary but the answer at it: `runCapability()`
 * threw `CAPABILITY_REQUIRED`, MCP reported that as an opaque `INTERNAL_ERROR`
 * with a ref only the server's own stderr could decode, and the caller had no
 * way to tell a deterministic configuration limit from a crash.
 */
function capabilityUnavailable(message) {
  return {
    statusCode: 501,
    body: workflowEnvelope({
      ok: false,
      status: 'capability_not_available',
      error: { code: 'CAPABILITY_NOT_AVAILABLE', message },
    }),
  };
}

/**
 * Why `advocate` cannot run here, or null when it can.
 *
 * This is a pre-check rather than a catch around `runCapability()` on purpose:
 * both conditions below are answerable from public kernel state, so reading
 * them directly keeps genuine faults inside the capability surfacing as the
 * internal errors they are, instead of being folded into "not available".
 */
function advocateUnavailableReason(kernel) {
  if (typeof kernel.hasCapability === 'function' && !kernel.hasCapability('pluginCapabilities')) {
    return 'advocate runs as a plugin capability, and this surface does not enable plugin capabilities.';
  }
  if (typeof kernel.getCapability === 'function' && !kernel.getCapability('devilAdvocate')) {
    return 'advocate needs the devil-advocate plugin capability, which is not registered on this surface.';
  }
  return null;
}

function searchMemory(graph, input) {
  const workspaceId = text(input.workspaceId, 128);
  const query = text(input.query || input.claim || input.node, 300).toLocaleLowerCase('tr');
  if (!workspaceId || !query) return null;

  const nodes = graph.getNodes(workspaceId);
  return Object.entries(nodes)
    .filter(([id, node]) => `${id} ${JSON.stringify(node)}`.toLocaleLowerCase('tr').includes(query))
    .slice(0, MAX_SEARCH_RESULTS)
    .map(([id, node]) => ({
      id,
      label: node.label || node.name || id,
      confidence: Number.isFinite(node.confidence) ? node.confidence : null,
      sourceRef: node.provenance?.sourceRef || node.sourceRef || null,
      provenanceId: node.provenance?.provenanceId || node.provenanceId || null,
      workspaceId,
    }));
}

async function runReadWorkflow({ workflowId, kernel, input = {}, ensureCapabilities = () => {} }) {
  const workspaceId = text(input.workspaceId, 128);
  if (!workspaceId) return invalid('workspaceId is required');

  if (workflowId === 'ask') {
    if (workspaceId !== 'default') return invalid('ask currently supports the default workspace only');
    const question = assertInput(input, ['question', 'query', 'claim']);
    if (!question) return invalid('question is required');
    return { statusCode: 200, body: completed(kernel.ask(question)) };
  }

  if (workflowId === 'verify') {
    const claim = assertInput(input, ['claim', 'statement', 'text']);
    if (!claim) return invalid('claim is required');
    return { statusCode: 200, body: completed(kernel.verify(claim, { workspaceId })) };
  }

  if (workflowId === 'advocate') {
    if (workspaceId !== 'default') return invalid('advocate currently supports the default workspace only');
    const claim = assertInput(input, ['claim', 'text', 'question']);
    if (!claim) return invalid('claim is required');
    ensureCapabilities();
    const unavailable = advocateUnavailableReason(kernel);
    if (unavailable) return capabilityUnavailable(unavailable);
    const result = await kernel.runCapability('devilAdvocate', { text: claim, workspaceId });
    const mode = result?.data?.mode === 'questions' ? 'unsupported' : result?.data?.mode;
    return {
      statusCode: 200,
      body: completed(result, { data: { ...result.data, mode } }),
    };
  }

  if (workflowId === 'memory-search') {
    const items = searchMemory(kernel.graph, input);
    if (!items) return invalid('workspaceId and query are required');
    return {
      statusCode: 200,
      body: completed({ data: { items, total: items.length, workspaceId } }),
    };
  }

  return {
    statusCode: 404,
    body: workflowEnvelope({
      ok: false,
      status: 'capability_not_available',
      error: { code: 'UNSUPPORTED_WORKFLOW', message: 'Read workflow is not available.' },
    }),
  };
}

function createReadWorkflowHttpRouter(options) {
  const { kernel, parseJsonRequest, writeJson, writeApiError, ensureCapabilities } = options;
  return async function handleReadWorkflow(req, res, reqUrl) {
    const match = reqUrl.pathname.match(/^\/api\/v2\/workflows\/(ask|verify|advocate|search)$/);
    if (!match) return false;
    if (req.method !== 'POST') {
      writeApiError(req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return true;
    }
    const input = await parseJsonRequest(req, res, { maxBytes: 8_192 });
    if (!input) return true;
    const workflowId = match[1] === 'search' ? 'memory-search' : match[1];
    try {
      const result = await runReadWorkflow({ workflowId, kernel, input, ensureCapabilities });
      writeJson(req, res, result.statusCode, result.body, { 'Cache-Control': 'no-store' });
    } catch (error) {
      console.error('[read-workflow] failed:', error);
      writeApiError(req, res, 500, 'WORKFLOW_FAILED', 'Read workflow failed.');
    }
    return true;
  };
}

module.exports = { createReadWorkflowHttpRouter, runReadWorkflow, searchMemory };

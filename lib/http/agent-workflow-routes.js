'use strict';

const { workflowEnvelope } = require('./workflow-envelope');
const { sanitizeMcpString, boundedMcpInteger, MCP_MAX_GOAL } = require('../mcp-input-sanitizers');

const NO_STORE = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});
const BODY_MAX_BYTES = 8_192;
const WORKSPACE_MAX = 128;
// Same bounds the MCP surface applies to huqan.plan / huqan.agent, so the two
// surfaces cannot disagree about what a caller is allowed to ask for.
const DEFAULT_MAX_STEPS = 4;
const MIN_MAX_STEPS = 1;
const MAX_MAX_STEPS = 8;

// The agent runtime already reports its own lifecycle. Map it onto the workflow
// contract's status enum so an HTTP caller branches on the same values an MCP
// or CLI caller sees, rather than on a surface-specific string. Anything not
// listed here is deliberately left to the envelope's ok-based fallback instead
// of being guessed into a success state.
const AGENT_STATUS_TO_WORKFLOW = Object.freeze({
  completed: 'completed',
  done: 'completed',
  paused: 'paused',
  blocked: 'blocked',
  partial: 'partial',
  failed: 'failed',
  // A run that returns while still 'running' did not reach its goal within the
  // step budget; that is partial progress, not completion.
  running: 'partial',
});

function failure(writeJson, req, res, statusCode, workflowId, code, message) {
  writeJson(req, res, statusCode, {
    workflowId,
    ...workflowEnvelope({ ok: false, status: 'failed', error: { code, message } }),
  }, NO_STORE);
}

function planBody(result, workspaceId) {
  const data = result?.data || {};
  return workflowEnvelope({
    ok: true,
    // The plan itself is the deliverable, so producing one is 'completed'.
    // data.status keeps the agent's own 'planned' marker.
    status: 'completed',
    data: {
      ...data,
      workspaceId: data.workspaceId || workspaceId,
      steps: Array.isArray(data.steps) ? data.steps : [],
      policy: data.policy || null,
    },
    evidence: result?.evidence,
    confidence: data.confidence,
  });
}

function runBody(result, workspaceId) {
  const data = result?.data || {};
  const agentStatus = String(data.status || '').toLowerCase();
  const status = AGENT_STATUS_TO_WORKFLOW[agentStatus] || (result?.ok ? 'completed' : 'failed');
  return workflowEnvelope({
    ok: status === 'completed',
    status,
    data: {
      ...data,
      // checkpointId is the agent's durable handle for this run, so it is what
      // a caller needs to correlate a later resume with this response.
      runId: data.checkpointId || null,
      workspaceId: data.workspaceId || workspaceId,
      steps: Array.isArray(data.steps) ? data.steps : [],
      nextAction: data.nextAction || null,
      pauseReason: data.pauseReason || null,
      resumeToken: data.resumeToken || null,
    },
    evidence: result?.evidence,
    confidence: data.confidence,
    receiptId: data.receiptId || result?.receiptId,
  });
}

// createAgent is called per request rather than once at wiring time: the agent
// runtime owns storage handles, and sharing one instance across concurrent HTTP
// callers would let their checkpoints interleave. Whatever this route opens, it
// closes before responding.
function createAgentWorkflowRoutes({ createAgent, parseJsonRequest, writeJson }) {
  if (![createAgent, parseJsonRequest, writeJson].every(fn => typeof fn === 'function')) {
    throw new TypeError('agent workflow route dependencies are required');
  }

  return async function handleAgentWorkflowRoute(req, res, reqUrl) {
    const isPlan = reqUrl.pathname === '/api/v2/agent/plan';
    const isRun = reqUrl.pathname === '/api/v2/agent/runs';
    if (!isPlan && !isRun) return false;

    const workflowId = isPlan ? 'agent-plan' : 'agent-run';
    if (req.method !== 'POST') {
      failure(writeJson, req, res, 405, workflowId, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return true;
    }

    const body = await parseJsonRequest(req, res, { maxBytes: BODY_MAX_BYTES });
    if (!body) return true;

    const workspaceId = sanitizeMcpString(body.workspaceId, WORKSPACE_MAX);
    const goal = sanitizeMcpString(body.goal, MCP_MAX_GOAL);
    if (!workspaceId) {
      failure(writeJson, req, res, 400, workflowId, 'INVALID_INPUT', 'workspaceId is required.');
      return true;
    }
    if (!goal) {
      failure(writeJson, req, res, 400, workflowId, 'INVALID_INPUT', 'goal is required.');
      return true;
    }
    const maxSteps = boundedMcpInteger(body.maxSteps, DEFAULT_MAX_STEPS, MIN_MAX_STEPS, MAX_MAX_STEPS);

    let agent;
    try {
      agent = createAgent();
    } catch (error) {
      console.error('[agent-workflow] runtime unavailable:', error);
      failure(writeJson, req, res, 503, workflowId, 'AGENT_RUNTIME_UNAVAILABLE', 'Agent runtime is unavailable.');
      return true;
    }

    try {
      const options = { maxSteps, workspaceId };
      const result = isPlan ? agent.plan(goal, options) : await agent.run(goal, options);
      if (!result || result.ok === false) {
        failure(writeJson, req, res, 422, workflowId,
          result?.error?.code || 'AGENT_WORKFLOW_FAILED',
          result?.error?.message || 'Agent workflow did not produce a result.');
        return true;
      }
      const envelope = isPlan ? planBody(result, workspaceId) : runBody(result, workspaceId);
      writeJson(req, res, 200, { workflowId, ...envelope }, NO_STORE);
    } catch (error) {
      console.error('[agent-workflow] failed:', error);
      failure(writeJson, req, res, 500, workflowId, 'AGENT_WORKFLOW_FAILED', 'Agent workflow failed.');
    } finally {
      try { agent?.storage?.close?.(); } catch (_) {}
    }
    return true;
  };
}

module.exports = { createAgentWorkflowRoutes, AGENT_STATUS_TO_WORKFLOW };

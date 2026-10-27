'use strict';

// #4065 PR-1: the production entry for native Coder work. An HTTP caller opens
// a review case for one scoped Coder task, and a distinct operator decides it.
// Nothing here executes code; execution of an approved case is a separate
// route. The case binds the exact repository root, branch, HEAD, workspace,
// goal and task, so a decision can never authorize anything wider.

const fs = require('node:fs');
const path = require('node:path');
const { workflowEnvelope } = require('./workflow-envelope');
const { emergencyStopRefusal, emergencyStopWorkflowBody } = require('./emergency-stop-gate');
const { readWorkflowDecisionCapability, verifyWorkflowDecisionCapability, OPERATOR_AUTH_REQUIRED_CODE,
  OPERATOR_DECISION_HEADER } = require('./workflow-decision-gate');
const { buildAgentCoderAction } = require('../agent-coder-execution');
const { AGENT_ACTION_FIREWALL_VERSION } = require('../agent-action-firewall');
const { buildHttpApproverContext, buildHttpRequesterContext } = require('../http-human-oversight-adapter-input');
const { isPlainObject } = require('../is-plain-object');

const NO_STORE = Object.freeze({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
const CASES_PATH = '/api/v2/agent/coder/cases';
const DECISION_PATH = /^\/api\/v2\/agent\/coder\/cases\/([^/]+)\/decision$/;
const RUNS_PATH = '/api/v2/agent/coder/runs';
// Same bound as the Coder queue itself (agent-coder-execution.js).
const MAX_RUN_CASES = 4;
const MAX_STEPS = 8;
const POLICY_VERSION = 'http-agent-coder-v1';
// buildAgentCoderAction stamps every Coder action with this connector.
const CODER_CONNECTOR = 'internal:coder';
const BODY_MAX_BYTES = 65_536;
const TEXT_MAX = 512;
// Phase 1 admits only project initialization: it writes into a new, empty
// target outside the source repository and is the only task whose acceptance
// outcome is independently observed today.
const ALLOWED_OPERATIONS = new Set(['initialize_project']);

function text(value, max = TEXT_MAX) {
  return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : '';
}

function canonical(target) {
  try { return fs.realpathSync.native(target); } catch { return ''; }
}

function allowedRoots(readEnvironment) {
  return String(readEnvironment('HUQAN_CODER_ROOTS') || '').split(path.delimiter).map(canonical).filter(Boolean);
}

// The target usually does not exist yet, so its nearest existing ancestor is
// resolved and the remainder appended; a link cannot move it outside the base.
function insideBase(target, base) {
  if (!base || !path.isAbsolute(target)) return false;
  let existing = path.resolve(target);
  const rest = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return false;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  const resolved = path.join(canonical(existing), ...rest);
  const relative = path.relative(base, resolved);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function scopeError(body, readEnvironment) {
  const root = canonical(text(body.root, 4096));
  if (!root || !allowedRoots(readEnvironment).includes(root)) return 'root is not an allowed Coder repository (HUQAN_CODER_ROOTS).';
  const operation = body.task?.operation;
  if (!ALLOWED_OPERATIONS.has(operation?.type)) return 'only initialize_project tasks are accepted.';
  const targetBase = canonical(text(readEnvironment('HUQAN_CODER_TARGET_ROOT'), 4096));
  if (!insideBase(String(operation.targetRoot || ''), targetBase)) {
    return 'targetRoot must lie under HUQAN_CODER_TARGET_ROOT.';
  }
  return '';
}

function createAgentCoderRoutes({ parseJsonRequest, writeJson, getOversightConfig, resolveAuthorityMode,
  emergencyStop, operatorToken = '', operatorCapabilityNonces, readEnvironment = name => process.env[name],
  getExperienceJournal = () => null, createAgent = null }) {
  function failure(req, res, status, workflowId, code, message) {
    writeJson(req, res, status, { workflowId, ...workflowEnvelope({ ok: false, status: 'failed', error: { code, message } }) }, NO_STORE);
    return true;
  }

  // Shared preconditions: a configured oversight runtime, the legacy decision
  // mode (an installed approval authority decides elsewhere, ADR-016) and no
  // emergency stop on the workspace.
  function precondition(req, res, workflowId, workspaceId) {
    const config = getOversightConfig();
    const runtime = config?.runtime;
    if (!runtime || ['createReviewCase', 'getReviewCase', 'decide', 'authorizeExecution', 'executeApprovedSync']
      .some(name => typeof runtime[name] !== 'function')) {
      failure(req, res, 503, workflowId, 'CODER_OVERSIGHT_UNCONFIGURED', 'Coder work needs a configured human oversight runtime.');
      return null;
    }
    if (resolveAuthorityMode().mode !== 'legacy') {
      failure(req, res, 409, workflowId, 'AUTHORITY_DECISION_REQUIRED',
        'This runtime answers to an approval authority; decide with it, then run huqan-authority apply.');
      return null;
    }
    const stop = emergencyStopRefusal({ emergencyStop, workspaceId });
    if (stop) {
      writeJson(req, res, stop.statusCode, { workflowId, ...emergencyStopWorkflowBody(stop) }, NO_STORE);
      return null;
    }
    return config;
  }

  async function openCase(req, res) {
    const workflowId = 'agent-coder-case';
    const body = await parseJsonRequest(req, res, { maxBytes: BODY_MAX_BYTES });
    if (!body) return true;
    const workspaceId = text(body?.workspaceId, 128);
    const goal = text(body?.goal, 2000);
    if (!isPlainObject(body) || !workspaceId || !goal || !isPlainObject(body.task)) {
      return failure(req, res, 400, workflowId, 'INVALID_INPUT', 'workspaceId, root, goal and task are required.');
    }
    const config = precondition(req, res, workflowId, workspaceId);
    if (!config) return true;
    const scope = scopeError(body, readEnvironment);
    if (scope) return failure(req, res, 403, workflowId, 'CODER_SCOPE_REFUSED', scope);
    let action;
    try {
      action = buildAgentCoderAction({ root: body.root, task: body.task, goal, workspaceId, journal: getExperienceJournal(),
        policyVersion: POLICY_VERSION, firewallVersion: AGENT_ACTION_FIREWALL_VERSION });
    } catch (error) {
      return failure(req, res, 400, workflowId, 'CODER_TASK_REFUSED', error.message);
    }
    const created = config.runtime.createReviewCase({ action, firewallDecision: 'review',
      requesterContext: buildHttpRequesterContext(config, { workspaceId, source: 'http-agent-coder' }),
      policy: { requireApproverDistinct: true, policyBasisRef: POLICY_VERSION },
      metadata: { source: 'http-agent-coder' } });
    if (!created?.ok) return failure(req, res, 409, workflowId, 'CODER_CASE_REFUSED', String(created?.reason || 'case_refused'));
    writeJson(req, res, 201, { workflowId, ...workflowEnvelope({ ok: true, status: 'queued', data: {
      caseId: created.case.caseId, workspaceId, status: created.case.status, evidenceDigest: created.case.evidenceDigest,
      expiresAt: created.case.expiresAt } }) }, NO_STORE);
    return true;
  }

  async function decideCase(req, res, caseId) {
    const workflowId = 'agent-coder-decision';
    const body = await parseJsonRequest(req, res, { maxBytes: BODY_MAX_BYTES });
    if (!body) return true;
    const workspaceId = text(body?.workspaceId, 128);
    const decision = text(body?.decision, 16).toLowerCase();
    const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 1000) : '';
    if (!workspaceId || !['approved', 'rejected'].includes(decision)) {
      return failure(req, res, 400, workflowId, 'INVALID_INPUT', 'workspaceId and decision approved|rejected are required.');
    }
    const config = precondition(req, res, workflowId, workspaceId);
    if (!config) return true;
    // Whoever can open a case with the transport key must not approve it with
    // the same key (#3926): the decision needs a scope-bound operator capability.
    const authorized = verifyWorkflowDecisionCapability({ operatorToken, capability: readWorkflowDecisionCapability(req),
      approvalId: caseId, workspaceId, decision, reason, nonceStore: operatorCapabilityNonces });
    if (!authorized) {
      return failure(req, res, 403, workflowId, OPERATOR_AUTH_REQUIRED_CODE,
        `A scoped operator capability is required. Present it in ${OPERATOR_DECISION_HEADER}.`);
    }
    const stored = config.runtime.getReviewCase(caseId);
    const reviewCase = stored?.case;
    // Only Coder cases are decided here; another kind of review case in the
    // same workspace keeps its own decision surface.
    if (!stored?.ok || !reviewCase || reviewCase.workspaceId !== workspaceId || reviewCase.connectorRef !== CODER_CONNECTOR) {
      return failure(req, res, 404, workflowId, 'CODER_CASE_NOT_FOUND', 'No Coder case with this id in the workspace.');
    }
    const decisionType = decision === 'approved' ? 'approve' : 'reject';
    const result = config.runtime.decide({ caseId, decisionType, reason: reason || `http_agent_coder_${decisionType}`,
      evidenceDigest: reviewCase.evidenceDigest,
      approverContext: buildHttpApproverContext(config, { caseId, workspaceId, decision: decisionType, reason }) });
    if (!result?.ok) return failure(req, res, 409, workflowId, 'CODER_DECISION_REFUSED', String(result?.reason || 'decision_refused'));
    writeJson(req, res, 200, { workflowId, ...workflowEnvelope({ ok: true, status: 'completed',
      data: { caseId, workspaceId, status: result.case?.status || decisionType } }) }, NO_STORE);
    return true;
  }

  // The case stores only the action fingerprint and args digest, so the caller
  // resends root/task/goal; the Coder adapter rebuilds the action and the
  // runtime refuses any field that differs from the approved one.
  function descriptorFor(entry, { goal, workspaceId, config, journal }) {
    const caseId = text(entry?.caseId, 256);
    if (!caseId || !isPlainObject(entry?.task)) return { error: 'every run needs caseId, root and task.' };
    const scope = scopeError(entry, readEnvironment);
    if (scope) return { error: scope, status: 403 };
    try {
      const action = buildAgentCoderAction({ root: entry.root, task: entry.task, goal, workspaceId, journal,
        policyVersion: POLICY_VERSION, firewallVersion: AGENT_ACTION_FIREWALL_VERSION });
      return { descriptor: { root: entry.root, task: entry.task, goal, action, caseId, journal,
        approvalRuntime: config.runtime,
        requesterContext: buildHttpRequesterContext(config, { workspaceId, source: 'http-agent-coder' }) } };
    } catch (error) {
      return { error: error.message };
    }
  }

  async function runCases(req, res) {
    const workflowId = 'agent-coder-run';
    const body = await parseJsonRequest(req, res, { maxBytes: BODY_MAX_BYTES });
    if (!body) return true;
    const workspaceId = text(body?.workspaceId, 128);
    const goal = text(body?.goal, 2000);
    const runs = Array.isArray(body?.runs) ? body.runs : [];
    if (!workspaceId || !goal || runs.length < 1 || runs.length > MAX_RUN_CASES) {
      return failure(req, res, 400, workflowId, 'INVALID_INPUT', `workspaceId, goal and 1-${MAX_RUN_CASES} runs are required.`);
    }
    const config = precondition(req, res, workflowId, workspaceId);
    if (!config) return true;
    if (typeof createAgent !== 'function') {
      return failure(req, res, 503, workflowId, 'AGENT_RUNTIME_UNAVAILABLE', 'Agent runtime is unavailable.');
    }
    const journal = getExperienceJournal();
    const queue = [];
    for (const entry of runs) {
      const built = descriptorFor(entry, { goal, workspaceId, config, journal });
      if (built.error) return failure(req, res, built.status || 400, workflowId, 'CODER_TASK_REFUSED', built.error);
      queue.push(built.descriptor);
    }
    let agent;
    try {
      agent = createAgent({ coderExecution: { queue } });
      // The workflow runtime has no Coder executor; refusing beats a run that
      // silently ignores the approved task.
      if (!agent?.baseAgent?.coderExecution) {
        return failure(req, res, 503, workflowId, 'CODER_RUNTIME_UNAVAILABLE', 'The configured agent runtime cannot execute Coder tasks.');
      }
      const maxSteps = Number.isInteger(body.maxSteps) ? Math.min(Math.max(body.maxSteps, 1), MAX_STEPS) : queue.length;
      const result = await agent.run(goal, { workspaceId, maxSteps, resume: false });
      const data = result?.data || {};
      const steps = (Array.isArray(data.steps) ? data.steps : []).map(step => ({ id: step.id, tool: step.tool,
        status: step.status, error: step.result?.error?.code || null }));
      writeJson(req, res, 200, { workflowId, ...workflowEnvelope({ ok: result?.ok !== false,
        status: data.status === 'completed' ? 'completed' : (result?.ok === false ? 'failed' : 'partial'),
        data: { workspaceId, status: data.status || null, caseIds: queue.map(item => item.caseId), steps } }) }, NO_STORE);
      return true;
    } catch (error) {
      console.error('[agent-coder] run failed:', error);
      return failure(req, res, 500, workflowId, 'AGENT_WORKFLOW_FAILED', 'Coder run failed.');
    } finally {
      try { agent?.storage?.close?.(); } catch (_) {}
    }
  }

  return async function handleAgentCoderRoute(req, res, reqUrl) {
    const pathname = reqUrl?.pathname || '';
    if (req.method !== 'POST') return false;
    if (pathname === CASES_PATH) return openCase(req, res);
    if (pathname === RUNS_PATH) return runCases(req, res);
    const match = DECISION_PATH.exec(pathname);
    if (!match) return false;
    let caseId;
    try { caseId = decodeURIComponent(match[1]); } catch { caseId = ''; }
    if (!text(caseId, 256)) return failure(req, res, 400, 'agent-coder-decision', 'INVALID_INPUT', 'caseId is invalid.');
    return decideCase(req, res, caseId);
  };
}

module.exports = { createAgentCoderRoutes };

'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { createHash } = require('node:crypto');
const { safeData, jsonValue, plain } = require('./coder/project-spec-data');
const { normalizeAction } = require('./human-oversight-approval-runtime');
const { runFixLoop } = require('./coder/fix-loop');
const { runArithmeticSynthesis } = require('./coder/arithmetic-synthesis');

function immutableData(value) {
  if (!safeData(value) || !jsonValue(value)) throw new TypeError('Coder scope must be plain JSON data');
  const clone = JSON.parse(JSON.stringify(value));
  const freeze = item => {
    if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); }
    return item;
  };
  return freeze(clone);
}

function readRepository(root) {
  const canonicalRoot = fs.realpathSync(root);
  const git = args => execFileSync('git', args, { cwd: canonicalRoot, encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
  if (fs.realpathSync(git(['rev-parse', '--show-toplevel'])) !== canonicalRoot) throw new Error('CODER_REPOSITORY_ROOT_MISMATCH');
  const branch = git(['symbolic-ref', '--short', 'HEAD']);
  const head = git(['rev-parse', 'HEAD']);
  const status = git(['status', '--porcelain', '--untracked-files=all']);
  if (status) throw new Error('CODER_REPOSITORY_NOT_CLEAN');
  return { root: canonicalRoot, branch, head, known: true, dirty: false, hasUntracked: false };
}

function taskScope(task) {
  const copy = immutableData(task);
  if (!plain(copy) || typeof copy.id !== 'string' || !copy.id.trim()
      || copy.operation?.type !== 'replace_text' || !plain(copy.test)
      || (copy.candidates !== undefined && (!Array.isArray(copy.candidates)
        || !copy.candidates.every(candidate => candidate?.type === 'replace_text')))
      || typeof copy.test.command !== 'string' || !copy.test.command.trim()) throw new Error('CODER_TASK_UNSUPPORTED');
  return copy;
}

function buildAgentCoderAction({ root, task, goal, workspaceId, policyVersion, firewallVersion } = {}) {
  const scopedTask = taskScope(task);
  if (typeof goal !== 'string' || !goal.trim() || typeof workspaceId !== 'string' || !workspaceId.trim()) throw new Error('CODER_SCOPE_REQUIRED');
  const repo = readRepository(root);
  const args = immutableData({ root: repo.root, branch: repo.branch, head: repo.head, goal, task: scopedTask });
  const action = {
    workspaceId, policyVersion, firewallVersion, requestedVerdict: 'review',
    requestedEffect: `Execute bounded Coder task ${scopedTask.id}`,
    connectorRef: 'internal:coder', resourceRef: repo.root, target: repo.root,
    actionType: 'code_change', toolName: 'coder', args,
    actionFingerprint: `agent-coder:${createHash('sha256').update(JSON.stringify({ workspaceId, args })).digest('hex')}`,
  };
  normalizeAction(action);
  return immutableData(action);
}

function createAgentCoderExecution(config = {}) {
  const { approvalRuntime, requesterContext, caseId, journal } = config;
  let task, action, expected, invalid = '';
  try {
    task = taskScope(config.task);
    action = immutableData(config.action);
    expected = buildAgentCoderAction({ root: config.root, task, goal: config.goal,
      workspaceId: action.workspaceId, policyVersion: action.policyVersion, firewallVersion: action.firewallVersion });
    if (!isDeepStrictEqual(action, expected)) throw new Error('CODER_APPROVAL_SCOPE_MISMATCH');
    if (!approvalRuntime || typeof approvalRuntime.authorizeExecution !== 'function'
        || typeof approvalRuntime.executeApprovedSync !== 'function' || typeof caseId !== 'string' || !caseId)
      throw new Error('CODER_APPROVAL_REQUIRED');
  } catch (error) { invalid = error.message; }

  const plannedStep = () => ({ id: `coder:${task.id}`, tool: 'coder', action: 'code_change',
    input: { action: 'code_change', target: expected.args.root, targetClass: 'internal', taskId: task.id } });
  const blocked = reason => ({ ok: false, reason });
  function validate({ step, state } = {}) {
    if (invalid) return blocked(invalid);
    if (!safeData(step) || state?.goal !== expected.args.goal
        || state?.workspaceId !== action.workspaceId
        || !isDeepStrictEqual({ id: step?.id, tool: step?.tool, action: step?.action, input: step?.input }, plannedStep()))
      return blocked('CODER_EXECUTION_SCOPE_MISMATCH');
    try {
      const repoState = readRepository(expected.args.root);
      if (repoState.head !== expected.args.head || repoState.branch !== expected.args.branch) return blocked('CODER_REPOSITORY_CHANGED');
      return { ok: true, repoState };
    } catch (error) { return blocked(error.message); }
  }

  function prepare(input) {
    const checked = validate(input);
    if (!checked.ok) return checked;
    const authorization = approvalRuntime.authorizeExecution({ caseId, action, requesterContext,
      firewallRequest: { context: { branch: checked.repoState.branch, repoState: checked.repoState } } });
    if (!authorization.ok) return blocked(authorization.reason);
    return { ok: true, firewallOpts: {
      agentActionApproval: { explicit: true, approved: true, reviewed: true, reviewedBy: authorization.case.latestDecisionId },
      branch: checked.repoState.branch, repoState: checked.repoState,
    } };
  }

  const envelope = (ok, data, reason, isBlocked) => ({ ok, type: 'coder', data, evidence: [],
    error: ok ? null : { code: reason || 'CODER_EXECUTION_FAILED', message: reason || 'Coder task failed' }, meta: { blocked: isBlocked } });
  function execute(input) {
    const checked = validate(input);
    if (!checked.ok) return envelope(false, null, checked.reason, true);
    let execution, invoked = false;
    try {
      execution = approvalRuntime.executeApprovedSync({ caseId, action, requesterContext,
        firewallRequest: { context: { branch: checked.repoState.branch, repoState: checked.repoState } }, executor: () => {
        const fresh = validate(input);
        if (!fresh.ok) return { ok: false, reason: fresh.reason };
        invoked = true;
        const options = { root: expected.args.root, task, workspaceId: action.workspaceId,
          repoState: fresh.repoState, authorized: true, ...(journal ? { journal } : {}) };
        return task.synthesis ? runArithmeticSynthesis(options) : runFixLoop(options);
      } });
    } catch (error) { return envelope(false, null, error.message, true); }
    if (!execution.result) return envelope(false, null, execution.reason, true);
    return envelope(execution.ok === true, execution.result, execution.result.reason || execution.reason, !invoked);
  }

  return Object.freeze({ approvalId: typeof caseId === 'string' ? caseId : '', plan: (goal, workspaceId) => !invalid && goal === expected.args.goal
    && workspaceId === action.workspaceId ? [plannedStep()] : [], prepare, execute });
}

module.exports = { buildAgentCoderAction, createAgentCoderExecution };

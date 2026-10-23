'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { createHash } = require('node:crypto');
const { safeData, jsonValue, plain } = require('./coder/project-spec-data');
const { normalizeAction, RUNTIME_REASONS } = require('./human-oversight-approval-runtime');
const { runFixLoop } = require('./coder/fix-loop');
const { runArithmeticSynthesis } = require('./coder/arithmetic-synthesis');

/**
 * Deep-freeze clone of a plain JSON-serializable value.
 * Locks coder task/action data so no caller can mutate the approved scope.
 * @param {any} value - plain JSON data to clone and freeze
 * @returns {Object} a frozen deep copy of the value
 * @throws {TypeError} when the value is not plain JSON data
 */
function immutableData(value) {
  if (!safeData(value) || !jsonValue(value)) throw new TypeError('Coder scope must be plain JSON data');
  const clone = JSON.parse(JSON.stringify(value));
  const freeze = item => {
    if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); }
    return item;
  };
  return freeze(clone);
}

/**
 * Resolve and validate the canonical Git repository root for a Coder task.
 * Confirms the path is inside a Git worktree and that the working tree is clean,
 * then returns the canonical root, current branch and HEAD.
 * @param {string} root - repository root path
 * @returns {{root:string,branch:string,head:string,known:boolean,dirty:boolean,hasUntracked:boolean}} repository state
 * @throws {Error} when the root is not a Git repository root or the tree is dirty
 */
function readRepository(root) {
  // `.native` also expands Windows 8.3 short names (RUNNER~1), which GitHub's Windows
  // runners use for TEMP; the JavaScript form leaves them short and the comparison fails.
  const canonicalRoot = fs.realpathSync.native(root);
  const git = args => execFileSync('git', args, { cwd: canonicalRoot, encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
  if (fs.realpathSync.native(git(['rev-parse', '--show-toplevel'])) !== canonicalRoot) throw new Error('CODER_REPOSITORY_ROOT_MISMATCH');
  const branch = git(['symbolic-ref', '--short', 'HEAD']);
  const head = git(['rev-parse', 'HEAD']);
  const status = git(['status', '--porcelain', '--untracked-files=all']);
  if (status) throw new Error('CODER_REPOSITORY_NOT_CLEAN');
  return { root: canonicalRoot, branch, head, known: true, dirty: false, hasUntracked: false };
}

/**
 * Validate and freeze a Coder task scope.
 * Only the replace_text operation family with a bounded test command is supported.
 * @param {Object} task - the coder task to scope
 * @returns {Object} a frozen deep copy of the validated task
 * @throws {Error} when the task is unsupported or malformed
 */
function taskScope(task) {
  const copy = immutableData(task);
  if (!plain(copy) || typeof copy.id !== 'string' || !copy.id.trim()
      || copy.operation?.type !== 'replace_text' || !plain(copy.test)
      || (copy.candidates !== undefined && (!Array.isArray(copy.candidates)
        || !copy.candidates.every(candidate => candidate?.type === 'replace_text')))
      || typeof copy.test.command !== 'string' || !copy.test.command.trim()) throw new Error('CODER_TASK_UNSUPPORTED');
  return copy;
}

/**
 * Build the normalized Coder approval action bound to a repository state.
 * The action's args digest ties the goal, task, workspace, branch and HEAD together
 * so scope drift or tampering is detected at authorization time.
 * @param {Object} params - action parameters
 * @param {string} params.root - repository root
 * @param {Object} params.task - validated coder task
 * @param {string} params.goal - execution goal
 * @param {string} params.workspaceId - target workspace
 * @param {string} params.policyVersion - host policy version
 * @param {string} params.firewallVersion - host firewall version
 * @returns {Object} the frozen approval action
 */
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

/**
 * Create a scoped Coder execution adapter backed by durable operator approval.
 * Returns a frozen object with approvalId, plan, prepare and execute. Every step
 * is re-validated against the approved action and repository state before running.
 * @param {Object} config - adapter configuration
 * @param {Object} config.approvalRuntime - human oversight approval runtime
 * @param {Object} config.requesterContext - receiver-owned requester context
 * @param {string} config.caseId - approval case id
 * @param {Object} [config.task] - coder task
 * @param {string} [config.goal] - execution goal
 * @param {string} [config.root] - repository root
 * @param {Object} [config.action] - prebuilt approval action
 * @param {Object} [config.journal] - optional coder journal
 * @returns {{approvalId:string,plan:function,prepare:function,execute:function}} frozen adapter
 */
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
/**
 * Validate a coder step against the approved action and repository state.
 * Re-checks the goal, workspace, step identity and HEAD/branch on every call.
 * @param {Object} params - validation parameters
 * @param {Object} params.step - the planned step
 * @param {Object} params.state - run state with goal and workspaceId
 * @returns {{ok:boolean,reason?:string,repoState?:Object}} validation result
 */
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

/**
 * Authorize and reserve a single-use Coder execution.
 * Returns blocked when validation or authorization fails, including when the host
 * approval runtime throws instead of returning a refusal.
 * @param {Object} input - step and state to prepare
 * @returns {{ok:boolean,reason?:string,firewallOpts?:Object}} preparation result
 */
  function prepare(input) {
    const checked = validate(input);
    if (!checked.ok) return checked;
    let authorization;
    try {
      authorization = approvalRuntime.authorizeExecution({ caseId, action, requesterContext,
        firewallRequest: { context: { branch: checked.repoState.branch, repoState: checked.repoState } } });
    } catch (error) { return blocked(error.message); }
    if (!authorization.ok) return blocked(authorization.reason);
    return { ok: true, firewallOpts: {
      agentActionApproval: { explicit: true, approved: true, reviewed: true, reviewedBy: authorization.case.latestDecisionId },
      branch: checked.repoState.branch, repoState: checked.repoState,
    } };
  }

  const envelope = (ok, data, reason, isBlocked, uncertain = false) => ({ ok, type: 'coder', data, evidence: [],
    error: ok ? null : { code: reason || 'CODER_EXECUTION_FAILED', message: reason || 'Coder task failed' },
    meta: { blocked: isBlocked, ...(uncertain ? { uncertain: true } : {}) } });
/**
 * Execute the approved Coder task through the reserved approval.
 * Runs synthesis or the fix loop inside the approval executor and records the outcome.
 * An execution that was invoked but lost its outcome is reported uncertain, not blocked:
 * it may have changed the repository and needs an operator verdict instead of a retry.
 * @param {Object} input - step and state to execute
 * @returns {{ok:boolean,type:string,data?:Object,error?:Object,meta:Object}} execution envelope
 */
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
    } catch (error) { return envelope(false, null, error.message, !invoked, invoked); }
    if (!execution.result) return envelope(false, null, execution.reason, !invoked, invoked);
    const uncertain = invoked && execution.reason === RUNTIME_REASONS.EXECUTION_RECONCILIATION_REQUIRED;
    return envelope(execution.ok === true && !uncertain, execution.result,
      uncertain ? execution.reason : execution.result.reason || execution.reason, !invoked, uncertain);
  }

  return Object.freeze({ approvalId: typeof caseId === 'string' ? caseId : '', plan: (goal, workspaceId) => !invalid && goal === expected.args.goal
    && workspaceId === action.workspaceId ? [plannedStep()] : [], prepare, execute });
}

module.exports = { buildAgentCoderAction, createAgentCoderExecution };

'use strict';

const { createHash } = require('node:crypto');
const { safeData, plain, onlyKeys } = require('./coder/project-spec-data');
const { produceProject } = require('./coder/project-producer');
const { loadProjectMethods } = require('./coder/project-method-memory');
const { inspectProjectInitializationScope } = require('./coder/project-initialization-permission');
const { initializeProject } = require('./coder/project-initialization');
const { readSealedRun } = require('./experience/learning-intake');
const { freezeResult } = require('./cognition/contract');

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// A task carries requirements, never executor options or mutation authority.
function scopeProjectTask({ root, task, journal, workspaceId }) {
  if (!safeData(task) || !plain(task) || !onlyKeys(task, ['id', 'operation'])
    || typeof task.id !== 'string' || !task.id.trim() || !plain(task.operation)
    || !onlyKeys(task.operation, ['type', 'targetRoot', 'spec', 'projectMemory'])
    || task.operation.type !== 'initialize_project' || typeof task.operation.targetRoot !== 'string'
    || !task.operation.targetRoot.trim()
    || (task.operation.projectMemory !== undefined && typeof task.operation.projectMemory !== 'string'))
    throw new Error('CODER_TASK_UNSUPPORTED');
  const inspected = inspectProjectInitializationScope({ root: task.operation.targetRoot, sourceRoot: root });
  const loaded = task.operation.projectMemory === undefined ? null : loadProjectMethods({
    file: task.operation.projectMemory, root: inspected.root, sourceRoot: inspected.source.root, journal, workspaceId,
  });
  if (loaded && !loaded.ok) throw new Error(loaded.reason);
  const produced = produceProject(task.operation.spec, loaded?.found ? {
    candidatePrograms: loaded.programs, pipelineContexts: loaded.pipelineContexts, methodContexts: loaded.methodContexts,
  } : {});
  if (!produced.ok) throw new Error(produced.reason);
  if (loaded && produced.plan.archetype !== 'node_computed_json_api') throw new Error('PROJECT_MEMORY_ARCHETYPE_UNSUPPORTED');
  return { source: inspected.source, targetRoot: inspected.root, taskHash: digest(produced.task),
    allowedPaths: produced.task.allowedPaths, testCommand: produced.task.test.command,
    memory: loaded ? { file: loaded.file, found: loaded.found, hash: loaded.hash ?? null } : null };
}

function checkProjectScope({ root, task, scope, journal, workspaceId }) {
  const live = scopeProjectTask({ root, task, journal, workspaceId });
  if (JSON.stringify(live.source) !== JSON.stringify(scope.source)) throw new Error('PROJECT_SOURCE_CHANGED');
  if (JSON.stringify(live.memory) !== JSON.stringify(scope.memory)) throw new Error('PROJECT_MEMORY_SOURCE_CHANGED');
  if (JSON.stringify(live) !== JSON.stringify(scope)) throw new Error('PROJECT_TASK_CHANGED');
  return live;
}

// Caller invokes this only inside its already-approved reserved executor.
function executeProjectTask({ root, task, scope, journal, workspaceId, runId }) {
  checkProjectScope({ root, task, scope, journal, workspaceId });
  return initializeProject(task.operation.spec, { root: scope.targetRoot, sourceRoot: scope.source.root,
    initialize: true, journal, workspaceId, ...(runId === undefined ? {} : { runId }),
    sourceBinding: scope.source, taskBindingHash: scope.taskHash,
    ...(scope.memory ? { projectMemory: scope.memory.file,
      projectMemoryBinding: { found: scope.memory.found, hash: scope.memory.hash } } : {}) });
}

// This receiver carries no approval. Only the reserved native executor arms it.
function createProjectObservation({ root, task, scope, journal, workspaceId, caseId, actionFingerprint }) {
  const captured = new WeakMap();
  let ticket = null, preparedKey = null, started = false, disabled = false;
  let producedTask;
  try {
    checkProjectScope({ root, task, scope, journal, workspaceId });
    const loaded = scope.memory ? loadProjectMethods({ file: scope.memory.file, root: scope.targetRoot,
      sourceRoot: root, journal, workspaceId }) : null;
    if (loaded && !loaded.ok) throw new Error(loaded.reason);
    const produced = produceProject(task.operation.spec, loaded?.found ? { candidatePrograms: loaded.programs,
      pipelineContexts: loaded.pipelineContexts, methodContexts: loaded.methodContexts } : {});
    if (!produced.ok || digest(produced.task) !== scope.taskHash) throw new Error('PROJECT_TASK_CHANGED');
    producedTask = JSON.parse(JSON.stringify(produced.task));
  } catch { disabled = true; }
  const scopeHash = digest({ workspaceId, caseId, actionFingerprint, scope });
  const empty = runId => {
    try { const rows = journal.read(runId); return Array.isArray(rows) && rows.length === 0; }
    catch { return false; }
  };
  function prepare({ expectation, decisionId } = {}) {
    try {
      if (disabled || !safeData(expectation) || !plain(expectation)
        || !onlyKeys(expectation, ['workspaceId', 'expected', 'sourceGroup', 'riskScore'])
        || expectation.workspaceId !== workspaceId || expectation.expected !== 'passed'
        || typeof expectation.sourceGroup !== 'string' || !expectation.sourceGroup.trim()
        || !(expectation.riskScore == null || (Number.isFinite(expectation.riskScore)
          && expectation.riskScore >= 0 && expectation.riskScore <= 100))
        || typeof decisionId !== 'string' || !decisionId.trim()
        || typeof caseId !== 'string' || !caseId || typeof actionFingerprint !== 'string' || !actionFingerprint)
        return null;
      const key = digest({ expectation, decisionId });
      if (ticket) return key === preparedKey ? ticket : null;
      const baseRunId = `coder-observed:${digest({ scopeHash, decisionId })}`;
      const runId = `${baseRunId}:c1`;
      if (!empty(runId)) { disabled = true; return null; }
      ticket = freezeResult({ ticketId: digest({ key, scopeHash }), decisionId, runId, baseRunId,
        sourceRef: `coder-run:${runId}`, scopeHash, sourceGroup: expectation.sourceGroup,
        riskScore: expectation.riskScore ?? null, workspaceId, root: scope.source.root,
        branch: scope.source.branch, head: scope.source.head });
      preparedKey = key;
      return ticket;
    } catch { return null; }
  }
  function start() {
    if (disabled || !ticket || started || !empty(ticket.runId)) { disabled = true; return undefined; }
    started = true;
    return ticket.baseRunId;
  }
  function capture(result) {
    if (!started || disabled || !result || typeof result !== 'object'
      || result.meta?.uncertain || result.data?.outcome === 'partial') return;
    captured.set(result, { ticketId: ticket.ticketId, decisionId: ticket.decisionId });
  }
  function read({ ticketId, decisionId, result } = {}) {
    try {
      const receipt = result && captured.get(result);
      if (!receipt || result.meta?.uncertain || result.data?.outcome === 'partial'
        || !ticket || receipt.ticketId !== ticketId || ticket.ticketId !== ticketId
        || receipt.decisionId !== decisionId || ticket.decisionId !== decisionId) return null;
      const sealed = readSealedRun(journal, ticket.runId, workspaceId);
      if (!sealed.ok) return null;
      const types = ['run_started', 'action_proposed', 'policy_decided', 'execution_started',
        'execution_finished', 'verification', 'run_closed'];
      const rows = types.map(type => sealed.events.filter(event => event.type === type));
      if (rows.some(events => events.length !== 1)) return null;
      const events = rows.map(events => events[0]);
      if (events.some((event, index) => event.workspaceId !== workspaceId
        || (index > 0 && (event.sequence <= events[index - 1].sequence
          || event.causedByEventId !== events[index - 1].eventId)))) return null;
      const [begin, proposed, policy, , finished, verified, closed] = events;
      if (begin.payload?.taskId !== producedTask.id || begin.payload?.operationType !== 'sequence'
        || JSON.stringify(begin.payload.allowedPaths) !== JSON.stringify(producedTask.allowedPaths)
        || proposed.payload?.sequenceSha256 !== digest(producedTask.operation)
        || proposed.payload?.sequenceSteps !== producedTask.operation.steps.length
        || proposed.payload?.operationType !== 'sequence' || policy.payload?.decision !== 'allow'
        || policy.payload?.reason !== 'PROJECT_INITIALIZATION_APPROVED') return null;
      const changes = finished.payload?.changes;
      if (!Array.isArray(changes) || changes.length !== producedTask.operation.steps.length
        || new Set(changes.map(change => change.path)).size !== changes.length
        || !producedTask.operation.steps.every(step => changes.some(change => change.path === step.path
          && change.afterSha256 === createHash('sha256').update(step.content).digest('hex')))) return null;
      const evidence = closed.payload?.evidence, test = evidence?.test;
      if (!test || test.ran !== true || test.command !== scope.testCommand || test.signal !== null) return null;
      const positive = test.ok === true && test.exitCode === 0 && test.reason === null
        && evidence.kept === true && closed.outcomeStatus === 'verified'
        && sealed.manifest.outcomeStatus === 'verified' && closed.executionStatus === 'completed'
        && closed.payload.verdict === 'complete' && verified.payload?.verified === true
        && ['integrity', 'coverage', 'verification', 'provenance', 'permission'].every(key => verified.proofs?.[key] === true);
      const negative = test.ok === false && test.exitCode === 1 && test.reason === 'TEST_FAILED'
        && evidence.kept === false && evidence.rolledBack === true
        && closed.executionStatus === 'failed' && closed.outcomeStatus === 'unknown'
        && sealed.manifest.outcomeStatus === 'unknown' && closed.payload.verdict === 'incomplete'
        // Initialization verifies rollback before sealing; later loop rollback also carries per-file checks.
        && (evidence.rollbackChecks === undefined || (Array.isArray(evidence.rollbackChecks)
          && evidence.rollbackChecks.length === producedTask.allowedPaths.length
          && new Set(evidence.rollbackChecks.map(check => check.path)).size === producedTask.allowedPaths.length
          && producedTask.allowedPaths.every(path => evidence.rollbackChecks.some(check => check.path === path && check.match === true))))
        && verified.proofs?.integrity === true && verified.proofs?.provenance === true && verified.proofs?.permission === true;
      return positive || negative ? freezeResult({ outcome: positive ? 'confirmed' : 'contradiction',
        sourceRef: ticket.sourceRef, sourceHash: sealed.sourceHash, scopeHash, runId: ticket.runId,
        sourceGroup: ticket.sourceGroup, decisionId }) : null;
    } catch { return null; }
  }
  return Object.freeze({ prepare, start, capture, read });
}

module.exports = { scopeProjectTask, checkProjectScope, executeProjectTask, createProjectObservation };
